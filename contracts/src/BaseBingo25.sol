// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Chainlink VRF v2.5
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient}       from "@chainlink/contracts/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

// OpenZeppelin
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/*
 * BaseBingo25 (Option B enabled)
 *  - 90-ball bingo (1..90)
 *  - Card of 24 numbers (CARD_SIZE=24)
 *  - USDC payments (6 decimals)
 *  - Payout: 95% to winner, 5% to feeRecipient
 *  - Chainlink VRF v2.5 for randomness
 *
 * BASE Sepolia / Base Mainnet VRF v2.5:
 *  - Coordinator, keyHash, subscription set in constructor
 */

contract BaseBingo25 is VRFConsumerBaseV2Plus, ReentrancyGuard {
    // ===== Constants & Config =====
    uint8  public constant CARD_SIZE   = 24;        // 24 numbers per card
    uint8  public constant MAX_NUMBER  = 90;        // 1..90
    uint32 public constant NUM_WORDS   = 1;
    uint16 public constant FEE_BPS     = 500;       // 5%
    uint256 public constant CARD_PRICE = 1_000_000; // 1 USDC (6 decimals)

    // VRF v2.5
    address public immutable vrfCoordinator;
    bytes32 public keyHash;
    uint256 public subscriptionId;
    uint16  public requestConfirmations = 3;
    uint32  public callbackGasLimit     = 200_000;

    // Payments
    IERC20  public immutable usdc;
    address public immutable feeRecipient;

    // requestId -> roundId
    mapping(uint256 => uint256) private reqToRound;

    // ===== Round State =====
    struct Round {
        uint64  startTime;
        uint64  joinDeadline;
        uint64  drawInterval;     // seconds between draws
        uint256 entryFee;

        address[] players;
        mapping(address => bool) joined;

        bool     vrfRequested;
        uint256  randomness;

        uint256  drawnMask;       // bit mask for 1..90
        uint8    drawCount;
        uint64   lastDrawTime;

        bool     finalized;
        address  winner;
        uint256  prizePool;       // in USDC (6 decimals)
    }

    mapping(uint256 => Round) private rounds;
    uint256 public currentRoundId;

    // ===== Events =====
    event RoundCreated(uint256 indexed roundId, uint64 startTime, uint256 entryFeeUSDC);
    event Joined(uint256 indexed roundId, address indexed player, uint256 paidUSDC);
    event VRFRequested(uint256 indexed roundId, uint256 indexed requestId);
    event VRFFulfilled(uint256 indexed roundId, uint256 randomness);
    event Draw(uint256 indexed roundId, uint8 number, uint8 drawIndex);
    event BingoClaimed(uint256 indexed roundId, address indexed player);
    event Payout(uint256 indexed roundId, address indexed winner, uint256 winnerUSDC, uint256 feeUSDC);

    // ===== Constructor =====
    constructor(
        address _vrfCoordinator,
        bytes32 _keyHash,
        uint256 _subId,
        address _usdc,
        address _feeRecipient
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        require(_vrfCoordinator != address(0), "bad coord");
        require(_usdc != address(0),           "bad usdc");
        require(_feeRecipient != address(0),   "bad fee");

        vrfCoordinator = _vrfCoordinator;
        keyHash        = _keyHash;
        subscriptionId = _subId;
        usdc           = IERC20(_usdc);
        feeRecipient   = _feeRecipient;
    }

    // ========== Round control ==========
    function createRound(
        uint64 startTime,
        uint64 joinWindow,
        uint64 drawInterval,
        uint256 entryFeeUSDC
    ) external returns (uint256) {
        require(startTime >= block.timestamp, "start must be future");
        require(entryFeeUSDC > 0, "fee must be > 0");

        uint256 rid = ++currentRoundId;
        Round storage r = rounds[rid];
        r.startTime    = startTime;
        r.joinDeadline = startTime + joinWindow;
        r.drawInterval = drawInterval;
        r.entryFee     = entryFeeUSDC;

        emit RoundCreated(rid, startTime, entryFeeUSDC);
        return rid;
    }

    /// @notice One card per address per round. USDC must be approved first.
    function joinRound(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        require(block.timestamp >= r.startTime,    "not started");
        require(block.timestamp <  r.joinDeadline, "join closed");
        require(!r.joined[msg.sender],             "already joined");

        uint256 cost = r.entryFee;
        require(usdc.transferFrom(msg.sender, address(this), cost), "USDC transferFrom failed");

        r.joined[msg.sender] = true;
        r.players.push(msg.sender);
        r.prizePool += cost;

        emit Joined(roundId, msg.sender, cost);
    }

    // ========== VRF v2.5 request ==========
    function requestRandomness(uint256 roundId) external returns (uint256 requestId) {
        Round storage r = rounds[roundId];
        require(block.timestamp >= r.joinDeadline, "join not ended");
        require(!r.vrfRequested,                   "already requested");

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

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords)
        internal
        override
    {
        uint256 roundId = reqToRound[requestId];
        if (roundId == 0) return;

        Round storage r = rounds[roundId];
        if (r.randomness == 0) {
            r.randomness   = randomWords[0];
            r.lastDrawTime = uint64(block.timestamp);
            emit VRFFulfilled(roundId, randomWords[0]);
        }
    }

    // ========== Draw ==========
    function drawNext(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.randomness != 0,                                 "no randomness yet");
        require(!r.finalized,                                      "round ended");
        require(block.timestamp >= r.lastDrawTime + r.drawInterval, "too early");
        require(r.drawCount < MAX_NUMBER,                           "all numbers drawn");

        uint8 num = _selectNext(r.randomness, r.drawCount, r.drawnMask);
        r.drawnMask   |= (uint256(1) << (num - 1));
        r.drawCount   += 1;
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
            uint8 cand = uint8((h % MAX_NUMBER) + 1); // 1..90
            if ((mask & (uint256(1) << (cand - 1))) == 0) {
                return cand;
            }
            probe++;
        }
    }

    // ========== Cards & Claim helpers ==========
    function cardOf(uint256 roundId, address player) public view returns (uint8[24] memory) {
        Round storage r = rounds[roundId];
        require(r.randomness != 0, "randomness not set");

        uint256 salt = uint256(keccak256(abi.encodePacked(r.randomness, player)));
        uint128 used = 0;
        uint8 idx = 0;
        uint8[24] memory arr;

        while (idx < CARD_SIZE) {
            uint256 h = uint256(keccak256(abi.encodePacked(salt, idx)));
            uint8 cand = uint8((h % MAX_NUMBER) + 1); // 1..90
            uint128 bit = uint128(1) << (cand - 1);
            if ((used & bit) == 0) {
                arr[idx] = cand;
                used    |= bit;
                idx++;
            } else {
                salt = uint256(keccak256(abi.encodePacked(salt, h)));
            }
        }
        return arr;
    }

    /// @notice View helper for bots: can `player` claim full-house now?
    function canClaimBingo(uint256 roundId, address player) external view returns (bool) {
        Round storage r = rounds[roundId];
        if (r.finalized || r.randomness == 0 || r.drawCount < 5) return false;
        if (!r.joined[player]) return false;

        uint8[24] memory my = cardOf(roundId, player);
        for (uint8 i = 0; i < CARD_SIZE; i++) {
            uint8 num = my[i];
            if ((r.drawnMask & (uint256(1) << (num - 1))) == 0) {
                return false;
            }
        }
        return true;
    }

    /// @notice Old flow: player self-claims.
    function claimBingo(uint256 roundId) external nonReentrant {
        _claim(roundId, msg.sender);
    }

    /// @notice New (Option B): anyone can claim on behalf of `player`.
    function claimBingoFor(uint256 roundId, address player) external nonReentrant {
        _claim(roundId, player);
    }

    function _claim(uint256 roundId, address player) internal {
        Round storage r = rounds[roundId];
        require(!r.finalized,      "already done");
        require(r.randomness != 0, "not ready");
        require(r.drawCount >= 5,  "not enough drawn");
        require(r.joined[player],  "not joined");

        // Check full house
        uint8[24] memory my = cardOf(roundId, player);
        for (uint8 i = 0; i < CARD_SIZE; i++) {
            uint8 num = my[i];
            if ((r.drawnMask & (uint256(1) << (num - 1))) == 0) {
                revert("not full bingo");
            }
        }

        r.finalized = true;
        r.winner    = player;

        uint256 fee = (r.prizePool * FEE_BPS) / 10_000;
        uint256 win = r.prizePool - fee;

        require(usdc.transfer(player, win), "USDC to winner failed");
        if (fee > 0) {
            require(usdc.transfer(feeRecipient, fee), "USDC fee failed");
        }

        emit BingoClaimed(roundId, player);
        emit Payout(roundId, player, win, fee);
    }

    // ========== Views / Helpers ==========
    function playersOf(uint256 roundId) external view returns (address[] memory) {
        return rounds[roundId].players;
    }

    function roundInfo(uint256 roundId) external view returns (
        uint64 startTime,
        uint64 joinDeadline,
        uint64 drawInterval,
        uint256 entryFeeUSDC,
        bool vrfRequested,
        uint256 randomness,
        uint256 drawnMask,
        uint8  drawCount,
        uint64 lastDrawTime,
        bool finalized,
        address winner,
        uint256 prizePoolUSDC
    ) {
        Round storage r = rounds[roundId];
        return (
            r.startTime,
            r.joinDeadline,
            r.drawInterval,
            r.entryFee,
            r.vrfRequested,
            r.randomness,
            r.drawnMask,
            r.drawCount,
            r.lastDrawTime,
            r.finalized,
            r.winner,
            r.prizePool
        );
    }
}
