# Community Loop (Reset Game) - how it works and the economic model

This document describes **Reset Game** / **Community Loop**: a mechanism built on **Redbelly Testnet**, a pool smart contract, and a **quiz backend**. It matches the logic in `contracts/`, `backend/index.js`, and `index.html` (as of the time of writing).

---

## 1. What is it?

- It is **not** a classic arcade game - it is a **social mechanism**: participants **extend the time cycle** (“pulse / reset”), **add to the pool** (sponsor), and **solve a quiz** to unlock the `resetTimer` transaction.
- **Value** comes from **RBNT** (the network’s native token) paid as the reset fee and voluntary contributions to the pool.
- Participation requires a **Web3 wallet** and **CAT** (Community Access Token) verification - without it, the UI will not allow full interaction.

---

## 2. Game cycle (round)

### Round duration

- Each round lasts **6 hours** (`ROUND_DURATION` in the contract).
- After the round starts, a **countdown timer** is shown until “prize distribution” (finalization).
- When time runs out, the round is **not automatically settled in the UI** - it needs **finalization** (`finalizeRound` / `finalizeRoundPermissionless`), which:
  - splits the pool according to the percentage model (below),
  - moves **part of the funds to the next round** (rollover),
  - opens a **new round** with a new `currentRoundId`.

### Grace period

- After the round timer ends, **30 minutes** (`FINALIZE_GRACE_PERIOD`) must pass before anyone can call **permissionless** finalization (without the operator role).

### On-chain state (what the frontend sees)

- The backend periodically refreshes state (`/api/loop/round-state`): `roundId`, `endTime`, `potBalance`, reset fee, etc.
- The UI clock syncs with chain time (with light local interpolation).

---

## 3. Economic model

### Pool (Community Pool)

- Funds in the current round’s pool come from:
  - **reset timer fees** (`resetTimer` - amount goes to `potBalance`),
  - **sponsorship** (`sponsorPot` or `receive()`),
  - any other ETH/RBNT deposits per the contract.

### Dynamic “Initiate Pulse” fee (`resetTimer`)

The fee is **not fixed** - it increases when less time remains in the round (incentivizing activity later in the round):

| Time left in round | Example logic (when `baseResetFee` = 5 RBNT) |
|--------------------|----------------------------------------------|
| more than 60 min   | **5 RBNT** (base)                            |
| ≤ 60 min           | **10 RBNT** (2× base)                        |
| ≤ 15 min           | **15 RBNT** (3× base)                        |
| after round `endTime` | reset **impossible** (“Round ended”)      |

Exact values depend on the deployed contract - above matches `RedbellyCommunityLoopDynamic.sol`.

### Pool split after finalization (100% of the pool)

After the round ends and finalization is called, **the pool is split** (UI naming):

| Share | % of pool | Role (UI / contract intuition) |
|-------|-----------|--------------------------------|
| **Guardian of the Cycle** | **40%** | Last address that **reset the timer** (`lastResetter`) - “keeping the cycle stable”. |
| **Core energy source** | **30%** | **Most active** participant (most `Reset` events in the round) - computed **off-chain** by the backend from logs. |
| **Carrier of randomness** | **20%** | **Randomly chosen** winner (backend signs the address - “entropy” is on the operator trust side). |
| **Continuity Pool** | **10%** | Stays in the contract as **rollover** - **funds the next round**, not a payout to a single address. |

If any target address is **zero** (no candidate), that share may be **redirected to rollover** (see `_finalize` in Solidity).

### Operator signatures (finalization)

- Payouts for “most active” and “random winner” require **operator signatures** (`quizSigner` / operator wallet in the contract - see `finalizeRound` and ECDSA verification in the contract).
- The frontend/backend generates these signatures after computing winners from the chain and the rules.

---

## 4. Quiz and backend (Knowledge Gate)

### Why a quiz?

- To execute **`resetTimer`**, the player must **answer correctly** (knowledge about the ecosystem / network).
- The backend draws a question from JSON files under `questions/` (configurable `QUESTIONS_DIR`).

### Attempt rules and cooldown

- **Up to 2 wrong answers** in a row (per attempt session) - after the second wrong answer a **30-minute cooldown** applies (see `COOLDOWN_MS` in the backend).
- After a **correct** answer, the backend returns an **ECDSA signature** (`signature` + `expiresAt`) that must match `quizSigner` on the contract for `resetTimer`.

### Signature validity

- The signature is short-lived (e.g. **~60 s** after issuance - see `expiresAt` in the backend); you must submit the `resetTimer` transaction before it expires.

---

## 5. How to play - step by step

### Prerequisites

1. **Browser with a wallet** (e.g. MetaMask).
2. **Network**: **Redbelly Testnet**, **Chain ID 153** (per `GAME_CONFIG` in `index.html`).
3. **RBNT** on the account for fees and optional sponsoring.
4. **CAT**: the wallet must pass `isAllowed` on the permissions contract (via Bootstrap) - otherwise the game will block you.

### Initiate Pulse (reset the timer)

1. Click **Connect** / connect the wallet (button in the UI).
2. Choose **Initiate Pulse** (or the label from your text config).
3. A **quiz modal** opens - pick **one** correct answer within the time limit (modal timer, e.g. 15 s).
4. On success, click **Confirm Transaction** - send **`resetTimer(expiresAt, signature)`** with **exact** `msg.value` equal to **`currentResetFee()`**.
5. After the block confirms, the round timer is **extended** by another 6 h (contract logic) and the fee goes to the **pool**.

### Reinforce This Cycle (sponsor)

1. Connect the wallet.
2. Use **Add Contribution** / sponsoring.
3. Enter an RBNT amount and confirm **`sponsorPot()`** (or equivalent) - funds increase the current round **pot**.

### Round finalization

- After the round time (and optionally the grace period), the **operator** or **any address** (permissionless after grace) can call finalization with the correct winner signatures - usually done by a **script / backend**, and the UI may expose a “stabilization” / finalize button depending on deployment.

---

## 6. Technical summary

| Piece | Description |
|--------|-------------|
| **Frontend** | Static `index.html` + JS (ethers), optional Grainient (WebGL). |
| **API** | Prefix e.g. `/api/loop/` → Node backend (port **4002** in a typical deploy). |
| **Contract** | Address in `GAME_CONFIG.contractAddress`; explorer: Routescan testnet. |
| **Events** | `Reset`, `Sponsored`, `Finalized` - used for stats and signatures. |

---

## 7. Where to look in the repo

- **Contract (percentages, timings, fees):** `loop/contracts/RedbellyCommunityLoopDynamic.sol`
- **Quiz, signatures, round-state, Reset/Sponsored logs:** `loop/backend/index.js`
- **UI, wallet, transactions:** `loop/index.html`
- **Questions:** `loop/questions/*.json` (or directory from `QUESTIONS_DIR`)

---

*If you change the contract address, network, or API port, update `GAME_CONFIG` in `index.html` and backend environment variables (`POT_GAME_CONTRACT_ADDRESS`, `RPC_URL`, `OPERATOR_KEY`, etc.).*
