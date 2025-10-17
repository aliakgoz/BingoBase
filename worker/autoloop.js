// autoloop.js — fault-tolerant + resumable Base Bingo loop
import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import fs from 'fs';
import path from 'path';

// ==== CONFIG ====
const RPC       = process.env.RPC_URL;
const PK        = process.env.SYSTEM_PK;
const CONTRACT  = process.env.CONTRACT;
const STATEFILE = path.join(process.cwd(), 'state.json');

const MAX_NUMBER             = 90;
const DEFAULT_DRAW_INTERVAL  = 5;
const POLL_MS                = 3000;
const RPC_TIMEOUT_MS         = 20_000;
const WAIT_TX_TIMEOUT_MS     = 60_000;
const WATCHDOG_MS            = 45_000;

if (!RPC || !PK || !CONTRACT) {
  console.error("Missing env vars: RPC_URL, SYSTEM_PK, CONTRACT");
  process.exit(1);
}

const abiPath = path.join(process.cwd(), 'BaseBingo25.abi.json');
const bingoAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
const provider = new JsonRpcProvider(RPC);
const signer = new Wallet(PK, provider);
const bingo = new Contract(CONTRACT, bingoAbi, signer);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => t = setTimeout(() => rej(new Error(`[timeout] ${label}`)), ms));
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

async function retry(fn, tries = 5, label = "op") {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await withTimeout(fn(), RPC_TIMEOUT_MS, label); }
    catch (e) {
      err = e;
      const wait = 600 * 2 ** i;
      console.warn(`[retry ${i + 1}/${tries}] ${e.message} — wait ${wait}ms`);
      await sleep(wait);
    }
  }
  throw err;
}

async function waitMined(hash) {
  try {
    const rcpt = await provider.waitForTransaction(hash, 1, WAIT_TX_TIMEOUT_MS);
    if (rcpt && rcpt.status !== 0) return rcpt;
  } catch (e) {
    if (!/timeout/i.test(e.message)) throw e;
  }
  const rcpt2 = await retry(() => provider.getTransactionReceipt(hash), 2, "getTxRcpt");
  if (rcpt2 && rcpt2.status !== 0) return rcpt2;
  throw new Error("tx not mined");
}

function parseRoundInfo(info) {
  return {
    startTime: Number(info[0]),
    joinDeadline: Number(info[1]),
    drawInterval: Number(info[2]),
    entryFee: info[3],
    vrfRequested: Boolean(info[4]),
    randomness: BigInt(info[5]),
    drawnMask: info[6],
    drawCount: Number(info[7]),
    lastDrawTime: Number(info[8]),
    finalized: Boolean(info[9]),
    winner: String(info[10]),
    prizePool: info[11],
  };
}

let lastProgressAt = Date.now();
let state = { lastRound: 0, lastDraw: 0 };

function saveState() {
  fs.writeFileSync(STATEFILE, JSON.stringify(state, null, 2));
}

function loadState() {
  if (fs.existsSync(STATEFILE)) {
    try { state = JSON.parse(fs.readFileSync(STATEFILE)); }
    catch { /* ignore */ }
  }
}

async function safeDraw(rid, count, interval) {
  console.log(`[loop] Draw (${count}/${MAX_NUMBER}) for ${rid}`);
  const tx = await retry(() => bingo.drawNext(rid), 5, "drawNext");
  await waitMined(tx.hash).catch(e => console.warn(`[waitTx] ${e.message}`));
  state.lastDraw = count;
  state.lastRound = rid;
  saveState();
  await sleep(Math.max(1000, (interval || DEFAULT_DRAW_INTERVAL) * 1000));
}

async function mainLoop() {
  const rid = Number(await retry(() => bingo.currentRoundId(), 3, "currentRoundId"));
  const info = parseRoundInfo(await retry(() => bingo.roundInfo(rid), 3, "roundInfo"));
  if (info.drawCount !== state.lastDraw || rid !== state.lastRound) {
    lastProgressAt = Date.now();
    state.lastDraw = info.drawCount;
    state.lastRound = rid;
    saveState();
  }

  if (info.finalized) {
    console.log(`[loop] Round ${rid} finalized`);
    await sleep(POLL_MS);
    return;
  }

  if (!info.vrfRequested && Date.now()/1000 > info.joinDeadline) {
    console.log(`[loop] Request VRF for ${rid}`);
    const tx = await retry(() => bingo.requestRandomness(rid), 5, "requestRandomness");
    await waitMined(tx.hash).catch(e => console.warn(`[waitTx VRF] ${e.message}`));
    return;
  }

  if (info.randomness !== 0n && info.drawCount < MAX_NUMBER) {
    const nextDraw = info.drawCount + 1;
    if (nextDraw > state.lastDraw) await safeDraw(rid, nextDraw, info.drawInterval);
  }

  await sleep(POLL_MS);
}

function attachEvents() {
  for (const e of ["VRFFulfilled", "Draw", "Payout", "RoundCreated"])
    bingo.on(e, (r) => { console.log(`[event] ${e} ${Number(r)}`); lastProgressAt = Date.now(); });
}

async function run() {
  loadState();
  attachEvents();
  const net = await provider.getNetwork();
  console.log(`[start] chainId=${Number(net.chainId)} contract=${CONTRACT}`);
  setInterval(async () => {
    const idle = Date.now() - lastProgressAt;
    if (idle > WATCHDOG_MS) {
      console.warn(`[watchdog] stalled ${idle/1000}s, checking state...`);
      try {
        const rid = Number(await bingo.currentRoundId());
        const info = parseRoundInfo(await bingo.roundInfo(rid));
        if (info.randomness !== 0n && info.drawCount < MAX_NUMBER)
          await safeDraw(rid, info.drawCount + 1, info.drawInterval);
        lastProgressAt = Date.now();
      } catch (e) { console.error(`[watchdog] ${e.message}`); }
    }
  }, 15_000);

  while (true) {
    try { await mainLoop(); }
    catch (e) { console.error(`[loop] ${e.message}`); await sleep(3000); }
  }
}

run();
