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

    uint256 public immutable baseResetFee; // 5 RBNT
    address public immutable quizSigner;
    address public immutable operator; // backend / DAO multisig

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    uint256 public currentRoundId;

    // Gas-optimised layout:
    //   slot 0: endTime(8) + potBalance(16) + finalized(1) = 25 bytes
    //   slot 1: lastResetter(20 bytes)
    // mostActive / randomWinner are passed as args to _finalize and emitted directly
    // entropy removed - backend is already trusted (signs every resetTimer call)
    struct Round {
        uint64  endTime;
        uint128 potBalance;
        bool    finalized;   // packed into slot 0 - saves 1 extra SLOAD in _finalize
        address lastResetter; // slot 1
    }

    mapping(uint256 => Round) public rounds;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Reset(uint256 indexed roundId, address indexed user, uint256 feePaid);
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
        uint256 _baseResetFee   // 5 RBNT
    ) {
        quizSigner   = _quizSigner;
        operator     = _operator;
        baseResetFee = _baseResetFee;

        currentRoundId = 1;
        rounds[1].endTime = uint64(block.timestamp + ROUND_DURATION);
    }

    /*//////////////////////////////////////////////////////////////
                      DYNAMIC RESET FEE LOGIC
    //////////////////////////////////////////////////////////////*/

    function currentResetFee() public view returns (uint256) {
        Round storage r = rounds[currentRoundId];

        if (block.timestamp >= r.endTime) return 0;

        uint256 timeRemaining = r.endTime - block.timestamp;

        // < 15 min → 15 RBNT
        if (timeRemaining <= 15 minutes) {
            return baseResetFee * 3; // 15 RBNT
        }

        // < 60 min → 10 RBNT
        if (timeRemaining <= 60 minutes) {
            return baseResetFee * 2; // 10 RBNT
        }

        // default → 5 RBNT
        return baseResetFee;
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
        if (block.timestamp > expiresAt) revert("Signature expired");

        uint256 requiredFee = currentResetFee();
        if (msg.value != requiredFee) revert("Wrong dynamic fee");

        bytes32 hash =
            keccak256(abi.encodePacked(msg.sender, currentRoundId, expiresAt));
        if (!_verify(hash, signature)) revert("Bad signature");

        // === EFFECTS ===
        // All three writes land in slot 0 (endTime+potBalance+finalized packed)
        // plus slot 1 (lastResetter) - total 2 SSTOREs vs 3 before
        r.endTime    = uint64(block.timestamp + ROUND_DURATION);
        r.potBalance += uint128(msg.value);
        r.lastResetter = msg.sender;

        emit Reset(currentRoundId, msg.sender, msg.value);
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
        // mostActive and randomWinner are NOT stored - only emitted in the event
        // (they were never read back by the contract, storing them was pure waste)

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
            mostActive,
            randomWinner
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
