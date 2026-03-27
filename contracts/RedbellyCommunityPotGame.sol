// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RedbellyCommunityPotGame {
    /*//////////////////////////////////////////////////////////////
                                CONFIG
    //////////////////////////////////////////////////////////////*/

    uint64 public constant ROUND_DURATION = 6 hours;
    uint64 public constant FINALIZE_GRACE_PERIOD = 30 minutes;

    uint8 public constant LAST_RESETTER_PERCENT = 40;
    uint8 public constant MOST_ACTIVE_PERCENT  = 30;
    uint8 public constant RANDOM_PERCENT       = 20;
    uint8 public constant ROLLOVER_PERCENT     = 10; // stays in contract

    uint256 public immutable resetFee;
    address public immutable quizSigner;
    address public immutable operator; // backend / DAO multisig

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    uint256 public currentRoundId;

    struct Round {
        uint64  endTime;
        uint128 potBalance;

        address lastResetter;
        address mostActive;
        address randomWinner;

        bytes32 entropy;
        bool finalized;
    }

    mapping(uint256 => Round) public rounds;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Reset(uint256 indexed roundId, address indexed user);
    event Sponsored(uint256 indexed roundId, address indexed sponsor, uint256 amount);
    event Finalized(
        uint256 indexed roundId,
        uint256 payoutTotal,
        uint256 rolloverAmount,
        address lastResetter,
        address mostActive,
        address randomWinner
    );

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address _quizSigner,
        address _operator,
        uint256 _resetFee
    ) {
        quizSigner = _quizSigner;
        operator   = _operator;
        resetFee   = _resetFee;

        currentRoundId = 1;
        rounds[1].endTime = uint64(block.timestamp + ROUND_DURATION);
    }

    /*//////////////////////////////////////////////////////////////
                          GAME FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function resetTimer(
        uint256 expiresAt,
        bytes calldata signature
    ) external payable {
        Round storage r = rounds[currentRoundId];

        if (block.timestamp >= r.endTime) revert("Round ended");
        if (msg.value != resetFee) revert("Wrong fee");
        if (block.timestamp > expiresAt) revert("Signature expired");

        bytes32 hash =
            keccak256(abi.encodePacked(msg.sender, currentRoundId, expiresAt));
        if (!_verify(hash, signature)) revert("Bad signature");

        r.endTime = uint64(block.timestamp + ROUND_DURATION);
        r.potBalance += uint128(msg.value);
        r.lastResetter = msg.sender;

        r.entropy = keccak256(
            abi.encodePacked(r.entropy, msg.sender, block.timestamp)
        );

        emit Reset(currentRoundId, msg.sender);
    }

    function sponsorPot() external payable {
        Round storage r = rounds[currentRoundId];
        if (block.timestamp >= r.endTime) revert("Round ended");

        r.potBalance += uint128(msg.value);
        emit Sponsored(currentRoundId, msg.sender, msg.value);
    }

    /*//////////////////////////////////////////////////////////////
                        ROUND FINALIZATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Operator finalizes with off-chain computed mostActive + randomWinner + signatures
    function finalizeRound(
        address mostActive,
        bytes calldata mostActiveSignature,
        address randomWinner,
        bytes calldata randomWinnerSignature
    ) external {
        require(msg.sender == operator, "Not operator");
        if (!_verifyFinalizeSignature(mostActive, mostActiveSignature)) revert("Bad mostActive signature");
        if (!_verifyRandomWinnerSignature(randomWinner, randomWinnerSignature)) revert("Bad randomWinner signature");
        _finalize(mostActive, randomWinner);
    }

    /// @notice Anyone can finalize after grace period with valid operator signatures
    function finalizeRoundPermissionless(
        address mostActive,
        bytes calldata mostActiveSignature,
        address randomWinner,
        bytes calldata randomWinnerSignature
    ) external {
        Round storage r = rounds[currentRoundId];
        require(
            block.timestamp >= r.endTime + FINALIZE_GRACE_PERIOD,
            "Grace period"
        );
        if (!_verifyFinalizeSignature(mostActive, mostActiveSignature)) revert("Bad mostActive signature");
        if (!_verifyRandomWinnerSignature(randomWinner, randomWinnerSignature)) revert("Bad randomWinner signature");
        _finalize(mostActive, randomWinner);
    }

    function _finalize(address mostActive, address randomWinner) internal {
        Round storage r = rounds[currentRoundId];

        if (block.timestamp < r.endTime) revert("Round active");
        if (r.finalized) revert("Already finalized");

        r.finalized = true;
        r.mostActive = mostActive;
        r.randomWinner = randomWinner;

        uint256 pot = r.potBalance;

        uint256 toLastResetter = (pot * LAST_RESETTER_PERCENT) / 100;
        uint256 toMostActive   = (pot * MOST_ACTIVE_PERCENT)   / 100;
        uint256 toRandomWinner = (pot * RANDOM_PERCENT)        / 100;

        // If a slot has no winner, redirect that share to rollover
        if (r.lastResetter == address(0)) toLastResetter = 0;
        if (mostActive     == address(0)) toMostActive   = 0;
        if (randomWinner   == address(0)) toRandomWinner = 0;

        uint256 payout   = toLastResetter + toMostActive + toRandomWinner;
        uint256 rollover = pot - payout;

        _safePay(r.lastResetter, toLastResetter);
        _safePay(mostActive,     toMostActive);
        _safePay(randomWinner,   toRandomWinner);

        emit Finalized(
            currentRoundId,
            payout,
            rollover,
            r.lastResetter,
            r.mostActive,
            r.randomWinner
        );

        currentRoundId++;
        rounds[currentRoundId].endTime =
            uint64(block.timestamp + ROUND_DURATION);
        rounds[currentRoundId].potBalance = uint128(rollover);
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL UTILS
    //////////////////////////////////////////////////////////////*/

    function _safePay(address to, uint256 amount) internal {
        if (to == address(0) || amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Payout failed");
    }

    function _verify(bytes32 hash, bytes calldata sig)
        internal
        view
        returns (bool)
    {
        bytes32 ethHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        return ecrecover(ethHash, v, r, s) == quizSigner;
    }

    /// @dev Verify that (currentRoundId, mostActive) was signed by operator (off-chain counting)
    function _verifyFinalizeSignature(address mostActive, bytes calldata sig)
        internal
        view
        returns (bool)
    {
        bytes32 hash = keccak256(abi.encodePacked(currentRoundId, mostActive));
        bytes32 ethHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        return ecrecover(ethHash, v, r, s) == operator;
    }

    /// @dev Verify that (currentRoundId, randomWinner) was signed by operator (off-chain: participants[entropy % length])
    function _verifyRandomWinnerSignature(address randomWinner, bytes calldata sig)
        internal
        view
        returns (bool)
    {
        bytes32 hash = keccak256(abi.encodePacked("randomWinner", currentRoundId, randomWinner));
        bytes32 ethHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        return ecrecover(ethHash, v, r, s) == operator;
    }

    function _split(bytes calldata sig)
        internal
        pure
        returns (bytes32 r, bytes32 s, uint8 v)
    {
        require(sig.length == 65, "Bad signature");
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
    }

    receive() external payable {
        rounds[currentRoundId].potBalance += uint128(msg.value);
    }
}
