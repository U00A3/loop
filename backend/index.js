/**
 * Quiz backend for Redbelly Community Pot Game.
 * Questions are drawn at random from JSON files in questions/.
 * 2 wrong answers → 30 min cooldown. After a correct answer → signature for resetTimer.
 */

import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
dotenv.config({ path: join(__dirname, ".env") }); // Load from backend/.env
const QUESTIONS_DIR = process.env.QUESTIONS_DIR ? join(__dirname, process.env.QUESTIONS_DIR) : join(PROJECT_ROOT, "questions");

const app = express();
app.use(cors());
app.use(express.json());

// ===== CONFIG =====
const PORT = process.env.PORT || 4002;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min
const MAX_ATTEMPTS = 2;

const PRIVATE_KEY = process.env.OPERATOR_KEY || process.env.QUIZ_SIGNER_KEY || process.env.DEPLOYER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.warn("OPERATOR_KEY not set – signatures will fail. Set in loop/backend/.env");
}
const signer = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY) : null;

// ===== STATE (in-memory) =====
const attempts = new Map(); // address => { fails, cooldownUntil, lastQuestionId }
const sponsorDisplayNames = new Map(); // address (lowercase) => displayName
let questionPool = []; // { id, question, options, correctIndex, correctText }

const DATA_DIR = join(__dirname, "data");
const SPONSOR_NAMES_FILE = join(DATA_DIR, "sponsor-display-names.json");

function loadSponsorDisplayNames() {
  try {
    if (!existsSync(SPONSOR_NAMES_FILE)) return;
    const raw = readFileSync(SPONSOR_NAMES_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      for (const [addr, name] of Object.entries(obj)) {
        const a = String(addr).toLowerCase();
        if (a && /^0x[a-f0-9]{40}$/i.test(a) && name != null && String(name).trim())
          sponsorDisplayNames.set(a, String(name).trim());
      }
      console.log("Loaded", sponsorDisplayNames.size, "sponsor display name(s) from", SPONSOR_NAMES_FILE);
    }
  } catch (e) {
    console.warn("Could not load sponsor names file:", e.message);
  }
}

function saveSponsorDisplayNames() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(sponsorDisplayNames);
    writeFileSync(SPONSOR_NAMES_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.warn("Could not save sponsor names file:", e.message);
  }
}

// ===== LOAD QUESTIONS FROM questions/*.json =====
function loadQuestions() {
  const pool = [];
  let files;
  try {
    files = readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch (e) {
    console.error("Cannot read questions dir:", QUESTIONS_DIR, e.message);
    return pool;
  }

  for (const file of files) {
    const path = join(QUESTIONS_DIR, file);
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      console.warn("Skip invalid JSON:", file, e.message);
      continue;
    }
    const list = data.questions;
    if (!Array.isArray(list)) {
      console.warn("Skip file without .questions array:", file);
      continue;
    }
    list.forEach((q, i) => {
      if (!q.question || !Array.isArray(q.options) || typeof q.correct !== "number") {
        console.warn("Skip malformed question in", file, "index", i);
        return;
      }
      const correctIndex = q.correct;
      const correctText = q.options[correctIndex];
      if (correctText == null) {
        console.warn("Skip question: correct index out of range in", file, "index", i);
        return;
      }
      pool.push({
        id: `${file}#${i}`,
        question: q.question,
        options: q.options,
        correctIndex,
        correctText: String(correctText).trim(),
        explanation: q.explanation != null ? String(q.explanation).trim() : null,
      });
    });
  }

  console.log("Loaded", pool.length, "questions from", files.length, "file(s) in", QUESTIONS_DIR);
  return pool;
}

function getRandomQuestion() {
  if (questionPool.length === 0) return null;
  return questionPool[Math.floor(Math.random() * questionPool.length)];
}

function findQuestionById(id) {
  return questionPool.find((q) => q.id === id) || null;
}

function now() {
  return Date.now();
}

// ===== ROUTES =====

app.get("/api/health", (req, res) => {
  res.json({ ok: true, questions: questionPool.length });
});

// Display names for sponsors (persisted to data/sponsor-display-names.json)
function handlePostSponsorDisplayName(req, res) {
  const { address, displayName } = req.body || {};
  const addr = (address && typeof address === "string") ? address.trim().toLowerCase() : "";
  if (!addr || addr.length !== 42 || !addr.startsWith("0x")) {
    return res.status(400).json({ error: "Address required" });
  }
  const name = (displayName != null && String(displayName).trim()) ? String(displayName).trim() : null;
  if (name) {
    sponsorDisplayNames.set(addr, name);
    saveSponsorDisplayNames();
    console.log("Sponsor display name saved:", addr.slice(0, 10) + "…", "→", name);
  }
  res.json({ ok: true });
}

function handleGetSponsorDisplayNames(req, res) {
  const addresses = req.query.addresses;
  if (!addresses) return res.json({});
  const list = (typeof addresses === "string" ? addresses.split(",") : []).map((a) => String(a).trim().toLowerCase()).filter((a) => a.length === 42 && a.startsWith("0x"));
  const out = {};
  list.forEach((addr) => {
    const name = sponsorDisplayNames.get(addr);
    if (name) out[addr] = name;
  });
  res.json(out);
}

app.post("/api/sponsor-display-name", handlePostSponsorDisplayName);
app.post("/sponsor-display-name", handlePostSponsorDisplayName);
app.get("/api/sponsor-display-names", handleGetSponsorDisplayNames);
app.get("/sponsor-display-names", handleGetSponsorDisplayNames);

function handleGetQuestion(req, res) {
  const address = req.query.address?.toLowerCase();
  if (!address) return res.status(400).json({ error: "Address required" });

  if (questionPool.length === 0) {
    return res.status(503).json({ error: "No questions loaded" });
  }

  const state = attempts.get(address);

  if (state?.cooldownUntil > now()) {
    return res.status(429).json({
      cooldown: true,
      retryAt: state.cooldownUntil,
    });
  }

  const q = getRandomQuestion();
  if (!q) return res.status(503).json({ error: "No questions" });

  if (!state) attempts.set(address, { fails: 0, cooldownUntil: 0, lastQuestionId: null });
  attempts.get(address).lastQuestionId = q.id;

  const payload = { question: q.question, options: q.options };
  if (q.explanation) payload.explanation = q.explanation;
  res.json(payload);
}

app.get("/question", handleGetQuestion);
app.get("/api/question", handleGetQuestion);

// 2️⃣ Answer question
async function handlePostAnswer(req, res) {
  const { address, answer, roundId } = req.body;
  if (!address || answer === undefined || answer === null || !roundId) {
    return res.status(400).json({ error: "Missing fields: address, answer, roundId" });
  }

  const user = address.toLowerCase();
  const state = attempts.get(user) || { fails: 0, cooldownUntil: 0, lastQuestionId: null };

  if (state.cooldownUntil > now()) {
    return res.status(429).json({
      cooldown: true,
      retryAt: state.cooldownUntil,
    });
  }

  const q = state.lastQuestionId ? findQuestionById(state.lastQuestionId) : null;
  const answerNorm = String(answer).trim().toLowerCase();
  const correct = q && q.correctText.toLowerCase() === answerNorm;

  // ❌ WRONG ANSWER (missing question / invalid answer)
  if (!correct) {
    state.fails += 1;

    if (state.fails >= MAX_ATTEMPTS) {
      state.cooldownUntil = now() + COOLDOWN_MS;
      state.fails = 0;
    }
    state.lastQuestionId = null;
    attempts.set(user, state);

    return res.json({
      success: false,
      cooldown: state.cooldownUntil > now(),
      retryAt: state.cooldownUntil || null,
    });
  }

  // ✅ CORRECT ANSWER
  state.fails = 0;
  state.cooldownUntil = 0;
  state.lastQuestionId = null;
  attempts.set(user, state);

  if (!signer) {
    return res.status(500).json({ error: "Signer not configured" });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 60;

  const hash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256"],
    [address, roundId, expiresAt]
  );

  const signature = await signer.signMessage(ethers.getBytes(hash));

  res.json({
    success: true,
    signature,
    expiresAt,
  });
}

app.post("/answer", handlePostAnswer);
app.post("/api/answer", handlePostAnswer);

// ===== MOST ACTIVE + RANDOM WINNER (off-chain counting, OPCJA 1) =====
const POT_GAME_ABI = [
  "event Reset(uint256 indexed roundId, address indexed user, uint256 feePaid)",
  "event Sponsored(uint256 indexed roundId, address indexed sponsor, uint256 amount)",
  // v2 struct: slot0=(endTime,potBalance,finalized), slot1=(lastResetter)
  // mostActive/randomWinner/entropy removed from storage (gas optimisation)
  "function rounds(uint256) view returns (uint64 endTime, uint128 potBalance, bool finalized, address lastResetter)",
  "function currentRoundId() view returns (uint256)",
  "function currentResetFee() view returns (uint256)",
  "function finalizeRound(address mostActive, bytes mostActiveSignature, address randomWinner, bytes randomWinnerSignature)",
];
const RPC_URL = process.env.RPC_URL;
const POT_CONTRACT_ADDRESS = process.env.POT_GAME_CONTRACT_ADDRESS;
const DEPLOY_BLOCK = process.env.DEPLOY_BLOCK ? Number(process.env.DEPLOY_BLOCK) : 2901640;
const LOG_CHUNK_SIZE = 500;
const LOG_CHUNK_DELAY_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared instances – created once, reused by all handlers
const sharedProvider = RPC_URL ? new ethers.JsonRpcProvider(RPC_URL) : null;
const sharedReadContract = (sharedProvider && POT_CONTRACT_ADDRESS)
  ? new ethers.Contract(POT_CONTRACT_ADDRESS, POT_GAME_ABI, sharedProvider) : null;
const sharedWriteContract = (signer && sharedProvider && POT_CONTRACT_ADDRESS)
  ? new ethers.Contract(POT_CONTRACT_ADDRESS, POT_GAME_ABI, signer.connect(sharedProvider)) : null;

// Start block of the current round – log scan begins here, not at DEPLOY_BLOCK
let knownRoundStartBlock = DEPLOY_BLOCK;

function getStartBlockForRound(ridStr) {
  if (roundStateCache && roundStateCache.roundId === ridStr && roundStateCache.roundStartBlock) {
    return roundStateCache.roundStartBlock;
  }
  return knownRoundStartBlock;
}

// Per-round Reset event cache – incremental
let resetEventsCache = { roundId: null, lastBlock: DEPLOY_BLOCK - 1, countByAddress: {}, seenLogKeys: new Set() };
let resetFetchInProgress = false;

// Per-round Sponsored event cache – incremental
let sponsoredEventsCache = { roundId: null, lastBlock: DEPLOY_BLOCK - 1, bySponsor: {}, seenLogKeys: new Set() };
let sponsoredFetchInProgress = false;

// Round state cache – refreshed every 30s via setInterval
const ROUND_STATE_FILE = join(DATA_DIR, "round-state.json");
let roundStateCache = null;

function loadRoundStateFromFile() {
  try {
    if (!existsSync(ROUND_STATE_FILE)) return null;
    const raw = readFileSync(ROUND_STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveRoundStateToFile(state) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ROUND_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.warn("Could not save round state:", e.message);
  }
}

async function fetchAndCacheRoundState() {
  if (!sharedProvider || !sharedReadContract) return;
  try {
    const [roundId, block] = await Promise.all([
      sharedReadContract.currentRoundId(),
      sharedProvider.getBlock("latest"),
    ]);
    const rid = BigInt(roundId.toString());
    const ridStr = roundId.toString();
    const [roundData, fee] = await Promise.all([
      sharedReadContract.rounds(rid),
      sharedReadContract.currentResetFee(),
    ]);
    // v2 struct: (endTime[0], potBalance[1], finalized[2], lastResetter[3])
    const endTime = Number(roundData?.endTime ?? roundData?.[0] ?? 0);
    const potBalance = (roundData?.potBalance ?? roundData?.[1] ?? 0n).toString();
    const finalized = roundData?.finalized ?? roundData?.[2] ?? false;
    const lastResetter = roundData?.lastResetter ?? roundData?.[3] ?? ethers.ZeroAddress;
    const chainNow = block ? Number(block.timestamp) : Math.floor(Date.now() / 1000);
    const currentBlock = block ? Number(block.number) : 0;

    // Round changed → store currentBlock as startBlock for the new round
    const prevRoundId = roundStateCache?.roundId;
    let roundStartBlock = roundStateCache?.roundStartBlock || DEPLOY_BLOCK;
    if (prevRoundId && prevRoundId !== ridStr) {
      roundStartBlock = currentBlock;
      knownRoundStartBlock = currentBlock;
      console.log(`Round changed ${prevRoundId} → ${ridStr}, roundStartBlock = ${currentBlock}`);
    }

    const state = {
      roundId: ridStr,
      endTime,
      potBalance,
      lastResetter,
      finalized,
      chainNow,
      currentBlock,
      fee: fee.toString(),
      roundStartBlock,
      fetchedAt: Date.now(),
    };
    roundStateCache = state;
    saveRoundStateToFile(state);
  } catch (e) {
    console.warn("fetchAndCacheRoundState error:", e.message);
  }
}

async function queryFilterWithRetry(contract, filter, from, to) {
  try {
    return await contract.queryFilter(filter, from, to);
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("too large block range") || msg.includes("block range")) {
      const mid = Math.floor((from + to) / 2);
      if (mid === from) throw e;
      const a = await queryFilterWithRetry(contract, filter, from, mid);
      await sleep(LOG_CHUNK_DELAY_MS);
      const b = await queryFilterWithRetry(contract, filter, mid + 1, to);
      return [...a, ...b];
    }
    throw e;
  }
}

// Explicit topic hash - avoids ethers.js BigInt filter bug where
// contract.filters.EventName(BigInt) can produce topics:undefined,
// causing queryFilter to return ALL contract events instead of only Sponsored
const SPONSORED_TOPIC = ethers.id("Sponsored(uint256,address,uint256)");
const RESET_TOPIC     = ethers.id("Reset(uint256,address,uint256)");

async function querySponsoredEventsChunked(contract, rid, provider) {
  if (sponsoredFetchInProgress) {
    while (sponsoredFetchInProgress) await sleep(200);
    return sponsoredEventsCache.bySponsor;
  }
  sponsoredFetchInProgress = true;

  try {
  const latestBlock = await provider.getBlockNumber();
  const ridStr = rid.toString();

  if (sponsoredEventsCache.roundId !== ridStr) {
    const startBlock = getStartBlockForRound(ridStr);
    sponsoredEventsCache = { roundId: ridStr, lastBlock: startBlock - 1, bySponsor: {}, seenLogKeys: new Set() };
  }
  if (!sponsoredEventsCache.seenLogKeys) {
    sponsoredEventsCache.seenLogKeys = new Set();
    // One-time fix after upgrade: old cache could double-count after refresh overlap
    const startBlock = getStartBlockForRound(ridStr);
    sponsoredEventsCache.lastBlock = startBlock - 1;
    sponsoredEventsCache.bySponsor = {};
  }

  const fromBlock = sponsoredEventsCache.lastBlock + 1;
  const bySponsor = { ...sponsoredEventsCache.bySponsor };
  const seenLogKeys = sponsoredEventsCache.seenLogKeys;

  if (fromBlock <= latestBlock) {
    const contractAddress = await contract.getAddress();
    const iface = contract.interface;
    const ranges = [];
    for (let from = fromBlock; from <= latestBlock; from += LOG_CHUNK_SIZE) {
      ranges.push({ from, to: Math.min(from + LOG_CHUNK_SIZE - 1, latestBlock) });
    }
    for (let i = 0; i < ranges.length; i++) {
      const { from, to } = ranges[i];
      try {
        // Use provider.getLogs with explicit topic to avoid ethers.js BigInt filter bug
        const rawLogs = await provider.getLogs({
          address: contractAddress,
          topics: [SPONSORED_TOPIC],
          fromBlock: from,
          toBlock: to,
        });
        for (const log of rawLogs) {
          try {
            // Dedupe: round-state/refresh rolls lastBlock back → same logs must not be summed twice
            const logKey = `${log.transactionHash}-${log.index}`;
            if (seenLogKeys.has(logKey)) continue;
            seenLogKeys.add(logKey);
            const decoded = iface.parseLog(log);
            const sponsor = decoded.args?.sponsor ?? decoded.args?.[1];
            const amount  = decoded.args?.amount  ?? decoded.args?.[2];
            if (sponsor && amount != null) {
              const addr = ethers.getAddress(sponsor.toString());
              const amt = BigInt(amount.toString());
              bySponsor[addr] = ((BigInt(bySponsor[addr] || "0")) + amt).toString();
            }
          } catch (_) {}
        }
      } catch (e) {
        console.warn(`Sponsored chunk fetch failed (${from}-${to}):`, e.message);
      }
      if (i < ranges.length - 1) await sleep(LOG_CHUNK_DELAY_MS);
    }
    sponsoredEventsCache = { roundId: ridStr, lastBlock: latestBlock, bySponsor, seenLogKeys };
  }

  return bySponsor;
  } finally {
    sponsoredFetchInProgress = false;
  }
}

async function queryResetEventsChunked(contract, rid, provider) {
  if (resetFetchInProgress) {
    while (resetFetchInProgress) await sleep(200);
    return resetEventsCache.countByAddress;
  }
  resetFetchInProgress = true;

  try {
  const latestBlock = await provider.getBlockNumber();
  const ridStr = rid.toString();

  if (resetEventsCache.roundId !== ridStr) {
    const startBlock = getStartBlockForRound(ridStr);
    resetEventsCache = { roundId: ridStr, lastBlock: startBlock - 1, countByAddress: {}, seenLogKeys: new Set() };
  }
  if (!resetEventsCache.seenLogKeys) {
    resetEventsCache.seenLogKeys = new Set();
    const startBlock = getStartBlockForRound(ridStr);
    resetEventsCache.lastBlock = startBlock - 1;
    resetEventsCache.countByAddress = {};
  }

  const fromBlock = resetEventsCache.lastBlock + 1;
  const countByAddress = { ...resetEventsCache.countByAddress };
  const seenLogKeys = resetEventsCache.seenLogKeys;

  if (fromBlock <= latestBlock) {
    const contractAddress = await contract.getAddress();
    const iface = contract.interface;
    const ranges = [];
    for (let from = fromBlock; from <= latestBlock; from += LOG_CHUNK_SIZE) {
      ranges.push({ from, to: Math.min(from + LOG_CHUNK_SIZE - 1, latestBlock) });
    }
    for (let i = 0; i < ranges.length; i++) {
      const { from, to } = ranges[i];
      try {
        // Use provider.getLogs with explicit topic to avoid ethers.js BigInt filter bug
        const rawLogs = await provider.getLogs({
          address: contractAddress,
          topics: [RESET_TOPIC],
          fromBlock: from,
          toBlock: to,
        });
        for (const log of rawLogs) {
          try {
            const logKey = `${log.transactionHash}-${log.index}`;
            if (seenLogKeys.has(logKey)) continue;
            seenLogKeys.add(logKey);
            const decoded = iface.parseLog(log);
            const user = decoded.args?.user ?? decoded.args?.[1];
            if (user) {
              const addr = ethers.getAddress(user.toString());
              countByAddress[addr] = (countByAddress[addr] || 0) + 1;
            }
          } catch (_) {}
        }
      } catch (e) {
        console.warn(`Reset chunk fetch failed (${from}-${to}):`, e.message);
      }
      if (i < ranges.length - 1) await sleep(LOG_CHUNK_DELAY_MS);
    }
    resetEventsCache = { roundId: ridStr, lastBlock: latestBlock, countByAddress, seenLogKeys };
  }

  return countByAddress;
  } finally {
    resetFetchInProgress = false;
  }
}

async function handleMostActiveSignature(req, res) {
  const roundId = req.query.roundId;
  if (roundId === undefined || roundId === null || String(roundId).trim() === "") {
    return res.status(400).json({ error: "roundId required" });
  }
  const rid = BigInt(String(roundId).trim());
  if (!sharedProvider || !sharedReadContract || !signer) {
    return res.status(503).json({ error: "Backend not configured for finalize (RPC, contract, signer)" });
  }
  try {
    const countByAddress = await queryResetEventsChunked(sharedReadContract, rid, sharedProvider);
    const entries = Object.entries(countByAddress).sort((a, b) => b[1] - a[1]);
    const mostActive = entries.length > 0
      ? ethers.getAddress(entries[0][0])
      : ethers.ZeroAddress;

    const participants = Object.keys(countByAddress).sort();
    let randomWinner = ethers.ZeroAddress;
    if (participants.length > 0) {
      // v2: entropy removed from contract - derive seed from latest block hash
      const latestBlock = await sharedProvider.getBlock("latest");
      const seed = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32"],
        [rid, latestBlock?.hash ?? ethers.ZeroHash]
      );
      const index = Number(BigInt(seed) % BigInt(participants.length));
      randomWinner = ethers.getAddress(participants[index]);
    }

    const hashMostActive = ethers.solidityPackedKeccak256(
      ["uint256", "address"],
      [rid, mostActive]
    );
    const mostActiveSignature = await signer.signMessage(ethers.getBytes(hashMostActive));

    const hashRandomWinner = ethers.solidityPackedKeccak256(
      ["string", "uint256", "address"],
      ["randomWinner", rid, randomWinner]
    );
    const randomWinnerSignature = await signer.signMessage(ethers.getBytes(hashRandomWinner));

    res.json({
      mostActive,
      signature: mostActiveSignature,
      randomWinner,
      randomWinnerSignature,
    });
  } catch (e) {
    console.warn("most-active-signature error:", e.message);
    res.status(500).json({ error: e.message || "Failed to compute finalize signatures" });
  }
}

app.get("/api/most-active-signature", handleMostActiveSignature);
app.get("/most-active-signature", handleMostActiveSignature);

// ===== CAN FINALIZE? (uses round-state cache - no extra RPC) =====
async function handleGetCanFinalize(req, res) {
  if (!roundStateCache) {
    return res.json({ canFinalize: false, error: "Round state not loaded yet" });
  }
  const { roundId, endTime, finalized, chainNow, currentBlock } = roundStateCache;
  const canFinalize = !finalized && chainNow >= endTime;
  return res.json({ canFinalize, roundId, endTime, chainNow, finalized, currentBlock });
}

app.get("/api/can-finalize", handleGetCanFinalize);
app.get("/can-finalize", handleGetCanFinalize);

// ===== FINALIZE ROUND (relayer – backend pays gas, user pays nothing) =====
let finalizeInProgress = false;

async function handlePostFinalizeRound(req, res) {
  if (!sharedWriteContract || !sharedProvider || !signer) {
    return res.status(503).json({ error: "Backend not configured (RPC, contract, signer)" });
  }
  if (finalizeInProgress) {
    return res.status(429).json({ error: "Finalization already in progress, please wait" });
  }
  finalizeInProgress = true;
  try {
    // Fast validation from cache (0 RPC) – refresh if older than 10s
    if (!roundStateCache || (Date.now() - roundStateCache.fetchedAt > 10_000)) {
      await fetchAndCacheRoundState();
    }
    const { roundId, endTime, finalized, chainNow } = roundStateCache || {};
    if (finalized) {
      return res.status(400).json({ error: "Round already finalized" });
    }
    if (chainNow < endTime) {
      return res.status(400).json({ error: "Round not ended yet" });
    }

    const rid = BigInt(roundId);
    const countByAddress = await queryResetEventsChunked(sharedReadContract, rid, sharedProvider);
    const entries = Object.entries(countByAddress).sort((a, b) => b[1] - a[1]);
    const mostActive = entries.length > 0 ? ethers.getAddress(entries[0][0]) : ethers.ZeroAddress;

    const participants = Object.keys(countByAddress).sort();
    let randomWinner = ethers.ZeroAddress;
    if (participants.length > 0) {
      // v2: entropy removed from contract - derive seed from latest block hash
      const latestBlock = await sharedProvider.getBlock("latest");
      const seed = ethers.solidityPackedKeccak256(
        ["uint256", "bytes32"],
        [rid, latestBlock?.hash ?? ethers.ZeroHash]
      );
      const index = Number(BigInt(seed) % BigInt(participants.length));
      randomWinner = ethers.getAddress(participants[index]);
    }

    const hashMostActive = ethers.solidityPackedKeccak256(["uint256", "address"], [rid, mostActive]);
    const mostActiveSignature = await signer.signMessage(ethers.getBytes(hashMostActive));
    const hashRandomWinner = ethers.solidityPackedKeccak256(["string", "uint256", "address"], ["randomWinner", rid, randomWinner]);
    const randomWinnerSignature = await signer.signMessage(ethers.getBytes(hashRandomWinner));

    const tx = await sharedWriteContract.finalizeRound(mostActive, mostActiveSignature, randomWinner, randomWinnerSignature);
    res.json({ ok: true, txHash: tx.hash });

    // Immediately set cache for new round → sponsors/resets start from currentBlock
    const currentBlock = roundStateCache?.currentBlock || 0;
    const newRidStr = (rid + 1n).toString();
    knownRoundStartBlock = currentBlock;
    resetEventsCache = { roundId: newRidStr, lastBlock: currentBlock, countByAddress: {}, seenLogKeys: new Set() };
    sponsoredEventsCache = { roundId: newRidStr, lastBlock: currentBlock, bySponsor: {}, seenLogKeys: new Set() };
    console.log(`Finalized round ${roundId}, pre-seeded cache for round ${newRidStr} from block ${currentBlock}`);

    // Refresh round-state in background (new round appears in cache after ~1–2s)
    setTimeout(fetchAndCacheRoundState, 3000);
  } catch (e) {
    console.warn("finalize-round error:", e.message);
    const msg = e.message || "Finalize failed";
    const isAlreadyFinalized = msg.includes("already finalized") || msg.includes("Bad mostActive signature") || msg.includes("Bad randomWinner signature");
    res.status(isAlreadyFinalized ? 400 : 500).json({ error: isAlreadyFinalized ? "Round already finalized" : msg });
  } finally {
    finalizeInProgress = false;
  }
}

app.post("/api/finalize-round", handlePostFinalizeRound);
app.post("/finalize-round", handlePostFinalizeRound);

// ===== SPONSORS (cached on backend, single request from frontend) =====
async function handleGetSponsors(req, res) {
  const roundId = req.query.roundId;
  if (roundId === undefined || roundId === null || String(roundId).trim() === "") {
    return res.status(400).json({ error: "roundId required" });
  }
  if (!sharedProvider || !sharedReadContract) {
    return res.status(503).json({ error: "Backend not configured" });
  }
  try {
    const rid = BigInt(String(roundId).trim());
    const bySponsor = await querySponsoredEventsChunked(sharedReadContract, rid, sharedProvider);
    res.json(bySponsor);
  } catch (e) {
    console.warn("sponsors error:", e.message);
    res.status(500).json({ error: e.message || "Failed to fetch sponsors" });
  }
}

app.get("/api/sponsors", handleGetSponsors);
app.get("/sponsors", handleGetSponsors);

// ===== ROUND STATE (cached, refreshed every 30s in the background) =====
app.get("/api/round-state", (req, res) => {
  if (!roundStateCache) {
    return res.status(503).json({ error: "Round state not yet loaded, retry in a moment" });
  }
  res.json(roundStateCache);
});
app.get("/round-state", (req, res) => {
  if (!roundStateCache) {
    return res.status(503).json({ error: "Round state not yet loaded, retry in a moment" });
  }
  res.json(roundStateCache);
});

// ===== FORCE REFRESH (call after sponsor/reset tx to update cache immediately) =====
app.post("/api/round-state/refresh", async (req, res) => {
  if (!sharedReadContract || !sharedProvider) {
    return res.status(503).json({ error: "RPC not configured" });
  }
  try {
    await Promise.all([
      fetchAndCacheRoundState(),
      // Invalidate sponsors cache so the next /sponsors response is fresh
      (() => { if (sponsoredEventsCache) sponsoredEventsCache.lastBlock = Math.max(0, sponsoredEventsCache.lastBlock - 2); })(),
    ]);
    res.json(roundStateCache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/round-state/refresh", async (req, res) => {
  if (!sharedReadContract || !sharedProvider) {
    return res.status(503).json({ error: "RPC not configured" });
  }
  try {
    await Promise.all([
      fetchAndCacheRoundState(),
      (() => { if (sponsoredEventsCache) sponsoredEventsCache.lastBlock = Math.max(0, sponsoredEventsCache.lastBlock - 2); })(),
    ]);
    res.json(roundStateCache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== START =====
questionPool = loadQuestions();
loadSponsorDisplayNames();

// Load last known round state from disk (immediate response after restart)
roundStateCache = loadRoundStateFromFile();
if (roundStateCache) {
  // Migration: if roundStartBlock equals DEPLOY_BLOCK, update to currentBlock
  if (!roundStateCache.roundStartBlock || roundStateCache.roundStartBlock <= DEPLOY_BLOCK) {
    roundStateCache.roundStartBlock = roundStateCache.currentBlock || DEPLOY_BLOCK;
    knownRoundStartBlock = roundStateCache.roundStartBlock;
    saveRoundStateToFile(roundStateCache);
  } else {
    knownRoundStartBlock = roundStateCache.roundStartBlock;
  }
  console.log(`Round state loaded from file: round ${roundStateCache.roundId}, startBlock ${roundStateCache.roundStartBlock}`);
}

app.listen(PORT, () => {
  console.log(`Quiz backend running on :${PORT} (${questionPool.length} questions from questions/)`);
});

// Poll round state every 30s + once immediately on startup
if (RPC_URL && POT_CONTRACT_ADDRESS) {
  fetchAndCacheRoundState().then(() => {
    console.log(`Round state fetched: round ${roundStateCache?.roundId}, endTime ${roundStateCache?.endTime}`);
  });
  setInterval(fetchAndCacheRoundState, 30_000);
}
