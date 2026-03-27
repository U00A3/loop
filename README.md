# Community Loop (Reset Game)

[![Solidity](https://img.shields.io/badge/Solidity-%5E0.8.20-363636?logo=solidity&logoColor=white)](./contracts/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Ethers](https://img.shields.io/badge/ethers.js-6.x-627EEA?logo=ethereum&logoColor=white)](https://docs.ethers.org/v6/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.x-38bdf8?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Network](https://img.shields.io/badge/network-Redbelly%20Testnet-FA423C)](https://redbelly.testnet.routescan.io/)
[![MVP](https://img.shields.io/badge/MVP-early%20stage-FA423C?logo=rocket&logoColor=white)](./AUDIT-REPORT.en.md)
[![Open app - testnet](https://img.shields.io/badge/Open%20app-testnet-FA423C?logo=googlechrome&logoColor=white)](https://game.mynode.uk/)

<!-- Shields: `MVP` is custom. Edit the **Open app** badge URL if your public base URL differs from production. -->

Community Loop (also referred to in the UI as Reset Game) is a web experience built on the Redbelly Testnet around a shared pool and a time-limited round. Participants who hold the required tokens and pass access checks can extend the clock on the current cycle, contribute to the pool, and - once the round matures - observe value flow according to a fixed distribution model (guardian reward, most active participant, randomness slot, and a portion rolled into the next cycle).

The experience is intentionally not framed as an arcade game. Its core is a participation-driven loop: fees and voluntary contributions feed the pot, while a short quiz acts as a knowledge gate before the backend signs and submits a timer reset to the chain. This keeps resets tied to ecosystem awareness, while the smart contract enforces timing, fund movement, and finalization rules.

All numerical parameters in the current implementation - token amounts, cycle duration, quiz difficulty, fee levels, and distribution ratios - are placeholder values used solely for demonstration on the Redbelly Testnet. They do not represent final economics. Any production deployment would require calibrating these parameters to real-world constraints, governance decisions, and ecosystem incentives.

---

## What you’ll find here

| Document | Purpose |
|----------|---------|
| **[SETUP.md](./SETUP.md)** | Install backend, configure env, serve the UI, quiz files, scripts, production checks |
| **[how-to.en.md](./how-to.en.md)** | How rounds, fees, the pool split, and quiz rules work in plain language |
| **[AUDIT-REPORT.en.md](./AUDIT-REPORT.en.md)** | **Self-audit** of the Solidity (tools, tests, findings - not a third-party review) |
| **[scripts/README-autorestart.md](./scripts/README-autorestart.md)** | systemd autostart / restart for the Node backend |

---

## Security and audit

The smart contract has undergone **only a self-audit** (internal review, static analysis, and tests). It is **not** a substitute for an independent security firm. Full write-up: **[AUDIT-REPORT.en.md](./AUDIT-REPORT.en.md)**.

**Before production** - especially mainnet, large TVL, or any deployment holding meaningful user funds - engage a **professional third-party audit**. Do not rely on this repository’s self-audit as your only safety bar.

---

## Getting started (quick pointer)

**Live app (testnet):** [game.mynode.uk](https://game.mynode.uk/) - use a Redbelly Testnet wallet, RBNT for fees, and satisfy CAT/access checks for your deployment. Update this URL in the README (and the *Open app* badge above) if you host the UI somewhere else.

**From source:**

1. Clone the repo and follow **[SETUP.md](./SETUP.md)** for Node, `backend/.env`, and questions.
2. Point `GAME_CONFIG` in `index.html` at your contract and API.
3. Read **[how-to.en.md](./how-to.en.md)** if you need to explain the product or verify behavior against the spec.

---

## License / brand

Smart contract and app materials are project-specific; adjust branding and legal notices for your own deployment.
