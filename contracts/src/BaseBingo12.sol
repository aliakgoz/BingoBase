// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient}       from "@chainlink/contracts/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";




// BASE Sepolia VRF v2.5:
// Coordinator:  0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE
// KeyHash:      0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71
// (Kaynak: Chainlink VRF v2.5 Supported Networks tablosu)  // docs referansı

contract BaseBingoV25 is VRFConsumerBaseV2Plus {
    // ===== VRF Config (v2.5) =====
    uint256 public subscriptionId;         // v2.5: uint256
    address public immutable vrfCoordinator;
    bytes32 public keyHash;
    uint16 public requestConfirmations = 3;
    uint32  public callbackGasLimit     = 200_000;
    uint32  public constant NUM_WORDS   = 1;

    // requestId -> roundId eşlemesi (v2.5’te şart)
    mapping(uint256 => uint256) private reqToRound;

    // ===== Bingo Config =====
    uint8 public constant CARD_SIZE  = 12; // 12 sayı
    uint8 public constant MAX_NUMBER = 99; // 1..99

    struct Round {
        uint64 startTime;
        uint64 joinDeadline;
        uint64 drawInterval;
        uint256 entryFee;

        address[] players;
        mapping(address => bool) joined;

        bool vrfRequested;
        uint256 randomness;

        uint256 drawnMask;
        uint8   drawCount;
        uint64  lastDrawTime;

        bool finalized;
        address winner;
        uint256 prizePool;
    }

    mapping(uint256 => Round) private rounds;
    uint256 public currentRoundId;

    // Events
    event RoundCreated(uint256 indexed roundId, uint64 startTime);
    event Joined(uint256 indexed roundId, address indexed player);
    event VRFRequested(uint256 indexed roundId, uint256 indexed requestId);
    event VRFFulfilled(uint256 indexed roundId, uint256 randomness);
    event Draw(uint256 indexed roundId, uint8 number, uint8 drawIndex);
    event BingoClaimed(uint256 indexed roundId, address indexed player);
    event Payout(uint256 indexed roundId, address indexed winner, uint256 amount);

    constructor(address _vrfCoordinator, bytes32 _keyHash, uint256 _subId)
        VRFConsumerBaseV2Plus(_vrfCoordinator)
    {
        vrfCoordinator = _vrfCoordinator;
        keyHash        = _keyHash;
        subscriptionId = _subId;
    }

    // ========== Round control ==========
    function createRound(
        uint64 startTime,
        uint64 joinWindow,
        uint64 drawInterval,
        uint256 entryFee
    ) external returns (uint256) {
        require(startTime >= block.timestamp, "start must be future");
        uint256 rid = ++currentRoundId;
        Round storage r = rounds[rid];
        r.startTime    = startTime;
        r.joinDeadline = startTime + joinWindow;
        r.drawInterval = drawInterval;
        r.entryFee     = entryFee;
        emit RoundCreated(rid, startTime);
        return rid;
    }

    function joinRound(uint256 roundId) external payable {
        Round storage r = rounds[roundId];
        require(block.timestamp >= r.startTime, "not started");
        require(block.timestamp <  r.joinDeadline, "join closed");
        require(msg.value == r.entryFee, "wrong fee");
        require(!r.joined[msg.sender], "already joined");

        r.joined[msg.sender] = true;
        r.players.push(msg.sender);
        r.prizePool += msg.value;
        emit Joined(roundId, msg.sender);
    }

    // ========== VRF v2.5 request ==========
    function requestRandomness(uint256 roundId) external returns (uint256 requestId) {
        Round storage r = rounds[roundId];
        require(block.timestamp >= r.joinDeadline, "join not ended");
        require(!r.vrfRequested, "already requested");

        // NOT: Sen LINK ile fonladın, o yüzden nativePayment:false (ETH ile ödemek istersen true yap)
        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash:              keyHash,
                subId:                subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit:     callbackGasLimit,
                numWords:             NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({ nativePayment: false })
                )
            })
        );

        r.vrfRequested = true;
        reqToRound[requestId] = roundId;
        emit VRFRequested(roundId, requestId);
    }

    // v2.5 fulfill
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords)
        internal
        override
    {
        uint256 roundId = reqToRound[requestId];
        if (roundId == 0) return; // güvenlik

        Round storage r = rounds[roundId];
        if (r.randomness == 0) {
            r.randomness   = randomWords[0];
            r.lastDrawTime = uint64(block.timestamp);
            emit VRFFulfilled(roundId, randomWords[0]);
        }
    }

    // ========== Drawing ==========
    function drawNext(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.randomness != 0, "no randomness yet");
        require(!r.finalized,       "round ended");
        require(block.timestamp >= r.lastDrawTime + r.drawInterval, "too early");

        uint8 num = _selectNext(r.randomness, r.drawCount, r.drawnMask);
        r.drawnMask  |= (uint256(1) << (num - 1));
        r.drawCount  += 1;
        r.lastDrawTime = uint64(block.timestamp);

        emit Draw(roundId, num, r.drawCount);
    }

    function _selectNext(
        uint256 seed,
        uint8   drawIndex,
        uint256 mask
    ) internal pure returns (uint8) {
        uint256 probe = 0;
        while (true) {
            uint256 h = uint256(keccak256(abi.encodePacked(seed, drawIndex, probe)));
            uint8 cand = uint8((h % MAX_NUMBER) + 1);
            if ((mask & (uint256(1) << (cand - 1))) == 0) {
                return cand;
            }
            probe++;
        }
    }

    // ========== Cards ==========
    function cardOf(uint256 roundId, address player) public view returns (uint8[12] memory) {
        Round storage r = rounds[roundId];
        require(r.randomness != 0, "randomness not set");
        uint256 salt = uint256(keccak256(abi.encodePacked(r.randomness, player)));
        uint128 used = 0;
        uint8 idx = 0;
        uint8[12] memory arr;
        while (idx < CARD_SIZE) {
            uint256 h = uint256(keccak256(abi.encodePacked(salt, idx)));
            uint8 cand = uint8((h % MAX_NUMBER) + 1);
            uint128 bit = uint128(1) << (cand - 1);
            if ((used & bit) == 0) {
                arr[idx] = cand;
                used |= bit;
                idx++;
            } else {
                salt = uint256(keccak256(abi.encodePacked(salt, h)));
            }
        }
        return arr;
    }

    // ========== Bingo ==========
    function claimBingo(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(!r.finalized,      "already done");
        require(r.randomness != 0, "not ready");
        require(r.drawCount >= 5,  "not enough drawn");

        uint8[12] memory my = cardOf(roundId, msg.sender);

        bool allMatch = true;
        for (uint8 i = 0; i < CARD_SIZE; i++) {
            uint8 num = my[i];
            if ((r.drawnMask & (uint256(1) << (num - 1))) == 0) {
                allMatch = false;
                break;
            }
        }
        require(allMatch, "not full bingo");

        r.finalized = true;
        r.winner    = msg.sender;
        uint256 prize = r.prizePool;

        (bool ok, ) = msg.sender.call{value: prize}("");
        require(ok, "transfer failed");

        emit BingoClaimed(roundId, msg.sender);
        emit Payout(roundId, msg.sender, prize);
    }

    // helper: players list
    function playersOf(uint256 roundId) external view returns (address[] memory) {
        return rounds[roundId].players;
    }
}
