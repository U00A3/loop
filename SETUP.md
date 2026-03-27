# Technical setup and deployment

Step-by-step install, configuration, and production notes for **Community Loop**. For what the mechanism *is* and how the economy works, see **[how-to.en.md](./how-to.en.md)**.

---

## Repository layout

| Path | Role |
|------|------|
| `index.html` | Static UI (ethers.js, wallet, quiz modal, on-chain reads) |
| `backend/` | Express API: quiz, ECDSA for `resetTimer`, round state cache, sponsors, finalize relay |
| `questions/` | Quiz JSON banks (loaded at backend startup) |
| `contracts/` | Solidity (`RedbellyCommunityLoopDynamic.sol`, etc.) |
| `scripts/` | Deploy helpers, systemd unit - see **[scripts/README-autorestart.md](./scripts/README-autorestart.md)** |
| `styles/` / `css/` | Tailwind source (`styles/tailwind-src.css`) and built CSS (`css/tailwind.css`) |

---

## Prerequisites

- **Node.js** 18+ (backend and root tooling)
- A wallet on **Redbelly Testnet** (Chain ID **153**), **RBNT** for fees, and **CAT** verification where your deployment requires it
- **Do not commit** `backend/.env`, private keys, or local question banks - use environment variables and gitignored files (see `.gitignore`)

---

## 1. Backend

```bash
cd backend
npm install
```

Create **`backend/.env`**. Minimum:

```env
PORT=4002
RPC_URL=https://governors.testnet.redbelly.network
POT_GAME_CONTRACT_ADDRESS=0x...your_deployed_contract...
OPERATOR_KEY=0x...your_quiz_signer_private_key...
```

Signing key resolution in code: `OPERATOR_KEY` → `QUIZ_SIGNER_KEY` → `DEPLOYER_PRIVATE_KEY` (see `backend/index.js`). Use the key that matches **`quizSigner`** on the deployed contract.

Optional:

- `QUESTIONS_DIR` - path relative to `backend/` for JSON question files (default: repo `questions/`)

Prepare questions (only **`questions/example.json`** is tracked; copy and add your own `*.json` locally):

```bash
cp ../questions/example.json ../questions/basic.json
# edit basic.json or add more *.json files
```

Start:

```bash
npm start
```

**Health check:** `GET http://localhost:4002/api/health` → `{ ok, questions }` (`questions` = size of loaded pool).

---

## 2. Frontend

The UI is static HTML/JS. Serve the repository root (or your public folder) with any static file server, **or** nginx + a reverse proxy to the backend.

Edit **`GAME_CONFIG`** in `index.html`:

- `contractAddress`, `chainId`, `rpcUrl`, `blockExplorerUrl`
- `apiBase` - must match how the browser reaches the API

**Local development:** if the backend runs on port 4002 with CORS enabled:

```js
apiBase: 'http://localhost:4002',
```

**Path prefix (e.g. `/api/loop`):** configure the reverse proxy so paths like `/api/loop/question` map to the backend routes the app calls (`/question`, `/api/question`, `/round-state`, etc.). The backend exposes both `/…` and `/api/…` variants for most endpoints.

---

## 3. Quiz JSON format

- The backend loads **every** `*.json` in the questions directory whose root has a **`questions`** array.
- Each item: `question` (string), `options` (string array), `correct` (zero-based index), optional `explanation`.
- Question IDs are derived as `filename.json#index` for session tracking.

---

## Useful scripts (repository root)

| Command | Description |
|---------|-------------|
| `npm install` | Root deps (deploy script, Tailwind CLI, solc) |
| `npm run build:css` | Build minified `css/tailwind.css` from `styles/tailwind-src.css` |
| `npm run deploy` | Contract deploy helper - needs `.env` with RPC and keys (see comments in `scripts/deploy-for-verify.js`) |

---

## Production

- Run the backend under **systemd** or a process manager so it starts on boot and restarts on failure - **[scripts/README-autorestart.md](./scripts/README-autorestart.md)**.
- Runtime files (sponsor display names, round-state cache) live under **`backend/data/`** (gitignored except `.gitkeep` if present).
- **Contract:** treat **[AUDIT-REPORT.en.md](./AUDIT-REPORT.en.md)** as a self-audit baseline only; schedule a **professional audit** before mainnet or significant TVL - see **[README.md](./README.md#security-and-audit)**.

---

## API surface (summary)

The backend implements quiz endpoints (`GET /question`, `POST /answer`), round aggregation (`GET /round-state`, `POST /round-state/refresh`), sponsors (`GET /sponsors`), display names, `can-finalize`, `finalize-round`, and `most-active-signature`. Many routes are duplicated without the `/api` prefix for proxy flexibility. Inspect `backend/index.js` for the authoritative list.
