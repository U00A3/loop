# Self-audit report – RedbellyCommunityPotGame

**Source file:** `audit-projects/redbelly-community-loop-dynamic/src/RedbellyCommunityLoopDynamic.sol`  
**Solidity contract:** `RedbellyCommunityPotGame`  
**Report date:** 2026-03-24  
**Solidity:** ^0.8.19 (Foundry profile `redbellyPotDynamic`)

*Polish version: `AUDIT-REPORT.md`*

---

## 1. Executive summary

The contract implements a round-based pot with a dynamic timer-reset fee, ECDSA signatures (`quizSigner` for resets, `operator` for finalization), and finalization either by the operator or permissionlessly after a grace period.

**Review outcome:** no critical logic flaws surfaced by unit tests; Slither reports, among other things, a potential reentrancy pattern in `_finalize` (CEI) and missing zero-address validation in the constructor. The design assumes trust in `operator` / `quizSigner` and does not use `nonReentrant` on payouts.

---

## 2. Scope

| Item | Status |
|------|--------|
| Slither static analysis | ✅ See `slither-initial.txt` (13 detector hits) |
| Solhint lint | ✅ See `solhint-output.txt` (0 errors, 71 warnings – mostly NatSpec / gas) |
| Foundry tests | ✅ **18/18** passed – `forge-test-output.txt` |
| Echidna / property fuzz | ⏸ Not run in this iteration |
| Manual review | ✅ Summary in section 5 |

---

## 3. Foundry test results

**Command:** `FOUNDRY_PROFILE=redbellyPotDynamic forge test --match-path "test/RedbellyCommunityLoopDynamic.t.sol"`

| Area | Tests |
|------|--------|
| Deploy / initial state | `test_Deploy_initialRound` |
| Dynamic fee | `test_CurrentResetFee_tiers`, `test_CurrentResetFee_zeroWhenRoundEnded` |
| resetTimer | `test_ResetTimer_success`, reverts: wrong fee, expired sig, bad sig, round ended |
| sponsorPot | `test_SponsorPot`, revert after round end |
| receive | `test_Receive_increasesPot` |
| finalize (operator) | `test_FinalizeRound_operator`, not operator, bad operator sig, round still active |
| finalize permissionless | revert before grace, success after grace |
| Finalization sequencing | `test_Finalize_secondCallRevertsRoundActive` (second attempt → new round, `Round active`) |

Full log: `forge-test-output.txt`.

---

## 4. Slither – notable findings

| Detector | Description | Assessment |
|----------|-------------|--------------|
| **reentrancy-eth** | In `_finalize`, `_safePay` (`.call`) runs before `currentRoundId++` and new round state writes | ⚠️ Theoretical reentrancy; `r.finalized = true` is set before payouts, which limits double-finalization of the same round. A recipient could re-enter via `receive`/`sponsorPot` and alter the current round’s `potBalance` during finalization – consider **nonReentrant** or **CEI** (complete state writes for the next round before payouts). |
| **reentrancy-events** | `Finalized` emitted after external calls | ℹ️ Log consistency vs. true state if reentrancy occurs. |
| **arbitrary-send-eth / low-level-calls** | `_safePay` sends ETH to addresses from game logic | ✅ Expected; relies on correct operator signatures for winners. |
| **missing-zero-check** | No `require(_quizSigner != 0)` / `require(_operator != 0)` | ⚠️ Low operational risk; easy fix. |
| **timestamp** | `block.timestamp` for timer and fee tiers | ℹ️ Common for on-chain games; miner manipulation is bounded. |
| **assembly** | `_split` for signature parsing | ℹ️ Verify `v` handling (27/28). |
| **solc-version** | Warning about known issues in ^0.8.19 | ℹ️ Consider a newer compiler after testing. |

Details: `slither-initial.txt`.

---

## 5. Short manual review

- **Trust model:** `quizSigner` and `operator` are central; key compromise implies full control over resets / finalized winners.  
- **receive():** ETH always increases `potBalance` of the **current** round without checking `endTime` – possible “top-ups” after the logical round end if finalization has not been executed yet (process-level edge case).  
- **Percentages:** 40+30+20=90% payouts, 10% rollover – consistent with `ROLLOVER_PERCENT`.  
- **Finalize signatures:** hashes include `currentRoundId` – after the round changes, new signatures are required (tests show a second finalize does not hit `Already finalized` in the same way but follows the next round’s logic).

---

## 6. Recommendations (priority)

1. **Low effort:** `require(_quizSigner != address(0) && _operator != address(0))` in the constructor.  
2. **Medium:** consider `ReentrancyGuard` on `finalizeRound` / `finalizeRoundPermissionless`, or move all state updates (including the new round) **before** the `_safePay` chain.  
3. **Process:** consider restricting `receive()` like `sponsorPot` (e.g. revert when `block.timestamp >= endTime`) if business rules require it.  
4. **Tooling:** add invariant tests / Echidna (e.g. simplified `pot == inflows - outflows` model).

---

## 7. Files in `reports/`

| File | Contents |
|------|----------|
| `AUDIT-REPORT.md` | This report (Polish) |
| `AUDIT-REPORT.en.md` | This report (English) |
| `slither-initial.txt` | Full Slither output |
| `solhint-output.txt` | Full Solhint output |
| `forge-test-output.txt` | Latest `forge test` run |

---

*Self-audit repository report; does not replace a third-party security audit.*
