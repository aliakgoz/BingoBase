// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Chainlink VRF v2.5 (brownie-contracts yolu ile)
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient}       from "@chainlink/contracts/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

// USDC ERC20
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/*
 * BaseBingo25
 *  - 90-ball bingo (1..90)
 *  - Kart 24 sayı (CARD_SIZE=24)
 *  - Kart fiyatı 1 USDC (6 decimals)
 *  - Ödeme USDC üzerinden alınır, ödül %95 kazanana, %5 feeRecipient adresine
 *  - VRF v2.5 ile randomness
 *
 * BASE Sepolia VRF v2.5:
 * Coordinator:  0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE
 * KeyHash:      0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71
 */

contract BaseBingo25 is VRFConsumerBaseV2Plus {
    // ===== Constants & Config =====
    uint8  public constant CARD_SIZE   = 24;        // kartta 24 sayı
    uint8  public constant MAX_NUMBER  = 90;        // 1..90
    uint32 public constant NUM_WORDS   = 1;         // 1 kelime randomness
    uint16 public constant FEE_BPS     = 500;       // %5 fee
    uint256 public constant CARD_PRICE = 1_000_000; // 1 USDC (6 decimals)

    // VRF v2.5
    address public immutable vrfCoordinator;
    bytes32 public keyHash;
    uint256 public subscriptionId;
    uint16  public requestConfirmations = 3;
    uint32  public callbackGasLimit     = 200_000;

    // Ödeme
    IERC20  public immutable usdc;
    address public immutable feeRecipient;

    // requestId -> roundId
    mapping(uint256 => uint256) private reqToRound;

    // ===== Round State =====
    struct Round {
        uint64  startTime;
        uint64  joinDeadline;
        uint64  drawInterval;     // her çekiliş arası saniye
        uint256 entryFee;         // USDC miktarı (6 decimals)

        address[] players;
        mapping(address => bool) joined;

        bool     vrfRequested;
        uint256  randomness;

        uint256  drawnMask;       // 1..90 için bit mask
        uint8    drawCount;
        uint64   lastDrawTime;

        bool     finalized;
        address  winner;
        uint256  prizePool;       // USDC miktarı (6 decimals)
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
        uint256 entryFeeUSDC // 6 decimals (örn: 1 USDC => 1_000_000)
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

    /// @notice Round başına adres başına tek kart.
    ///         Ödeme USDC ile alınır, önce dApp'te approve yapılmış olmalı.
    function joinRound(uint256 roundId) public {
        // Önce teşhis: revert sebebini net olarak verelim
        revertIfCannotJoin(roundId, msg.sender);

        Round storage r = rounds[roundId];

        // USDC tahsil et
        uint256 cost = r.entryFee;
        require(usdc.transferFrom(msg.sender, address(this), cost), "USDC transferFrom failed");

        r.joined[msg.sender] = true;
        r.players.push(msg.sender);
        r.prizePool += cost;

        emit Joined(roundId, msg.sender, cost);
    }

    /// @notice Eski arayüzle uyumluluk için wrapper
    function joinRoundWithUSDC(uint256 roundId) external {
        joinRound(roundId);
    }

    // ========== VRF v2.5 request ==========
    function requestRandomness(uint256 roundId) external returns (uint256 requestId) {
        Round storage r = rounds[roundId];
        require(block.timestamp >= r.joinDeadline, "join not ended");
        require(!r.vrfRequested,                   "already requested");

        // nativePayment: false (LINK ile fonlanan subscription)
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
        require(r.randomness != 0,                                  "no randomness yet");
        require(!r.finalized,                                       "round ended");
        require(block.timestamp >= r.lastDrawTime + r.drawInterval, "too early");
        require(r.drawCount < MAX_NUMBER, "all numbers drawn");     // Tüm 90 sayı çekildiyse bitir

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

    // ========== Cards ==========
    /// @notice 24’lük kart üretimi: address+round randomness deterministik
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
                // çakışma olduysa tuzu saptır, tekrar dene
                salt = uint256(keccak256(abi.encodePacked(salt, h)));
            }
        }
        return arr;
    }

    // ========== Bingo (Full House) ==========
    /// @dev Basit kural: 24 sayının tamamı çekildiyse kazanır (full house).
    ///      Oyun biri kazanana ya da 90 sayı tamamen çekilene kadar sürer.
    function claimBingo(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(!r.finalized,      "already done");
        require(r.randomness != 0, "not ready");
        require(r.drawCount >= 5,  "not enough drawn"); // erken spam'i önlemek için küçük eşik

        // Kartı üret ve tüm sayılar çekilmiş mi kontrol et
        uint8[24] memory my = cardOf(roundId, msg.sender);
        bool allMatch = true;
        for (uint8 i = 0; i < CARD_SIZE; i++) {
            uint8 num = my[i];
            if ((r.drawnMask & (uint256(1) << (num - 1))) == 0) {
                allMatch = false;
                break;
            }
        }
        require(allMatch, "not full bingo");

        // Ödül dağıt
        r.finalized = true;
        r.winner    = msg.sender;

        uint256 fee = (r.prizePool * FEE_BPS) / 10_000;
        uint256 win = r.prizePool - fee;

        require(usdc.transfer(msg.sender, win), "USDC to winner failed");
        if (fee > 0) {
            require(usdc.transfer(feeRecipient, fee), "USDC fee failed");
        }

        emit BingoClaimed(roundId, msg.sender);
        emit Payout(roundId, msg.sender, win, fee);
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
        uint8 drawCount,
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

    // ===== Debug / Diagnostics =====
    error NotStarted(uint64 nowTs, uint64 startTime);
    error JoinClosed(uint64 nowTs, uint64 joinDeadline);
    error AlreadyJoined(address player);
    error NoAllowance(uint256 allowance, uint256 need);
    error NoBalance(uint256 balance, uint256 need);

    function canJoin(uint256 roundId, address player)
        public
        view
        returns (bool ok, string memory reason)
    {
        Round storage r = rounds[roundId];
        if (r.startTime == 0) return (false, "round not exist");
        if (block.timestamp < r.startTime) return (false, "not started");
        if (block.timestamp >= r.joinDeadline) return (false, "join closed");
        if (r.joined[player]) return (false, "already joined");

        uint256 need = r.entryFee;
        uint256 alw  = usdc.allowance(player, address(this));
        if (alw < need) return (false, "allowance too low");
        uint256 bal  = usdc.balanceOf(player);
        if (bal < need) return (false, "balance too low");

        return (true, "");
    }

    function revertIfCannotJoin(uint256 roundId, address player) public view {
        Round storage r = rounds[roundId];
        if (r.startTime == 0) revert("round not exist");
        if (block.timestamp < r.startTime) revert NotStarted(uint64(block.timestamp), r.startTime);
        if (block.timestamp >= r.joinDeadline) revert JoinClosed(uint64(block.timestamp), r.joinDeadline);
        if (r.joined[player]) revert AlreadyJoined(player);

        uint256 need = r.entryFee;
        uint256 alw  = usdc.allowance(player, address(this));
        if (alw < need) revert NoAllowance(alw, need);

        uint256 bal  = usdc.balanceOf(player);
        if (bal < need) revert NoBalance(bal, need);
    }
}
