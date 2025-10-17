// autoloop.js — Base Mainnet • Node 18+ • Ethers v6
import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet, NonceManager, parseUnits } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';

// ===== ENV =====
const RPC       = process.env.RPC_URL;
const PK        = process.env.SYSTEM_PK;
const CONTRACT  = process.env.CONTRACT;

const MAX_NUMBER = 90;
const DEFAULT_JOIN_WINDOW_SEC = 240; // 2 dk
const DEFAULT_DRAW_INTERVAL   = 5;   // sn (kontrakt zaten enforce ediyor)
const POLL_MS                 = 1500;
const TX_TIMEOUT_MS           = 45_000; // 45s içinde mining olmazsa replace
const FEE_BUMP_FACTOR_NUM     = 120;    // %20 bump
const FEE_BUMP_FACTOR_DEN     = 100;

// ===== ABI (json import uyarısından kaçın) =====
const abiPath = path.join(process.cwd(), 'BaseBingo25.abi.json');
if (!fs.existsSync(abiPath)) {
  console.error(`ABI not found at ${abiPath}`);
  process.exit(1);
}
const bingoAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));

// ===== Provider & Signer =====
if (!RPC || !PK || !CONTRACT) {
  console.error('Missing env. Required: RPC_URL, SYSTEM_PK, CONTRACT');
  process.exit(1);
}
const provider = new JsonRpcProvider(RPC);
const wallet   = new Wallet(PK, provider);
const signer   = new NonceManager(wallet); // nonce güvenliği
const bingo    = new Contract(CONTRACT, bingoAbi, signer);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, tries = 5, baseMs = 600) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const wait = baseMs * Math.pow(2, i);
      console.warn(`${ts()}: [retry ${i+1}/${tries}] ${msg(e)} — wait ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function ts() { return new Date().toISOString(); }
function msg(e){ return e?.shortMessage ?? e?.message ?? String(e); }

async function waitProviderHealthy() {
  const net = await retry(() => provider.getNetwork());
  console.log(`${ts()}: [startup] chainId=${Number(net.chainId)} (hex: 0x${Number(net.chainId).toString(16)})`);
  if (Number(net.chainId) !== 8453) {
    throw new Error(`Wrong network. Expected Base mainnet (8453). Got ${Number(net.chainId)}.`);
  }
  console.log(`${ts()}: [startup] CONTRACT=${CONTRACT}`);
  const code = await retry(() => provider.getCode(CONTRACT));
  if (!code || code === '0x') throw new Error(`No bytecode at ${CONTRACT}`);
}

// ---- Fee helpers (EIP-1559) ----
const MIN_PRIORITY = 100_000n;   // 0.1 gwei (Base genelde çok düşük; taban koy)
const MIN_FEE      = 500_000n;   // 0.5 gwei maxFee tabanı

function bump(num) {
  return (num * BigInt(FEE_BUMP_FACTOR_NUM)) / BigInt(FEE_BUMP_FACTOR_DEN);
}

async function getInitialFees() {
  const fd = await provider.getFeeData();
  let maxPriorityFeePerGas = fd.maxPriorityFeePerGas ?? MIN_PRIORITY;
  let maxFeePerGas         = fd.maxFeePerGas ?? MIN_FEE;

  if (maxPriorityFeePerGas < MIN_PRIORITY) maxPriorityFeePerGas = MIN_PRIORITY;
  if (maxFeePerGas < MIN_FEE) maxFeePerGas = MIN_FEE;

  // güvenli marj: maxFee >= baseFee*2 + priority
  const block = await provider.getBlock('latest');
  const base  = (block?.baseFeePerGas ?? 0n);
  const safe  = base * 2n + maxPriorityFeePerGas;
  if (maxFeePerGas < safe) maxFeePerGas = safe;

  return { maxPriorityFeePerGas, maxFeePerGas };
}

// Replaceable tx gönder – timeout’ta/underpriced’te gazı artırıp aynı nonce ile tekrar dener
async function sendReplaceable(sendFn, label) {
  let { maxPriorityFeePerGas, maxFeePerGas } = await getInitialFees();
  let attempts = 0;
  while (attempts < 6) {
    attempts++;
    try {
      const tx = await sendFn({ maxPriorityFeePerGas, maxFeePerGas });
      console.log(`${ts()}: [loop] ${label} tx=${tx.hash}`);
      const rc = await provider.waitForTransaction(tx.hash, 1, TX_TIMEOUT_MS);
      if (!rc) {
        console.warn(`${ts()}: [waitTx] tx not mined`);
        // replace aynı nonce: NonceManager zaten aynı nonce’ı kullanır; sadece fee’yi arttır.
        maxPriorityFeePerGas = bump(maxPriorityFeePerGas);
        maxFeePerGas         = bump(maxFeePerGas);
        continue;
      }
      if (rc.status !== 1) throw new Error(`${label} reverted`);
      return rc;
    } catch (e) {
      const m = msg(e);
      if (m.includes('REPLACEMENT_UNDERPRICED') || m.includes('underpriced')) {
        // daha agresif artış
        maxPriorityFeePerGas = bump(maxPriorityFeePerGas);
        maxFeePerGas         = bump(maxFeePerGas);
        console.warn(`${ts()}: [replace] underpriced → bump & retry`);
        continue;
      }
      if (m.includes('NONCE_EXPIRED') || m.includes('nonce too low')) {
        // zincirde zaten işlenmiş olabilir; ileri bakıp durumu teyit et
        console.warn(`${ts()}: [nonce] expired → state check`);
        return null; // üst katman state’e bakıp karar versin
      }
      if (m.includes('intrinsic transaction cost') || m.includes('insufficient funds')) {
        console.error(`${ts()}: [funds] ${m}`);
        throw e;
      }
      console.warn(`${ts()}: [sendReplaceable] ${m}`);
      // genel durumda da bir bump dene
      maxPriorityFeePerGas = bump(maxPriorityFeePerGas);
      maxFeePerGas         = bump(maxFeePerGas);
    }
  }
  throw new Error(`${label} failed after multiple replacements`);
}

// ---- Game utils ----
function parseRoundInfo(info) {
  return {
    startTime:    Number(info[0]),
    joinDeadline: Number(info[1]),
    drawInterval: Number(info[2]),
    entryFee:     info[3],
    vrfRequested: Boolean(info[4]),
    randomness:   BigInt(info[5]),
    drawnMask:    info[6],
    drawCount:    Number(info[7]),
    lastDrawTime: Number(info[8]),
    finalized:    Boolean(info[9]),
    winner:       String(info[10]),
    prizePool:    info[11],
  };
}

async function createNextRound(entryFee) {
  const now = Math.floor(Date.now() / 1000);
  await sendReplaceable(
    (ov) => bingo.createRound(BigInt(now + 10), BigInt(DEFAULT_JOIN_WINDOW_SEC), BigInt(DEFAULT_DRAW_INTERVAL), entryFee, ov),
    `CreateNext(start=${now+10})`
  );
  console.log(`${ts()}: [Next] Round scheduled`);
}

async function ensureNextRoundExists() {
  const rid = Number(await retry(() => bingo.currentRoundId()));
  if (rid === 0) {
    console.log(`${ts()}: [Init] No rounds yet. Creating the first one...`);
    await createNextRound(1_000_000n); // 1 USDC (6 decimals)
  }
}

async function resumeIfInMiddle() {
  const rid  = Number(await retry(() => bingo.currentRoundId()));
  if (rid === 0) return;
  const info = parseRoundInfo(await retry(() => bingo.roundInfo(rid)));
  const now  = Math.floor(Date.now() / 1000);

  if (info.finalized) {
    console.log(`${ts()}: [Resume] Round ${rid} finalized. Creating next...`);
    await createNextRound(info.entryFee);
    return;
  }
  if (!info.vrfRequested && now > info.joinDeadline) {
    console.log(`${ts()}: [Resume] Requesting VRF for ${rid}...`);
    await sendReplaceable((ov) => bingo.requestRandomness(rid, ov), `VRF(${rid})`);
  }
  if (info.randomness !== 0n && info.drawCount < MAX_NUMBER) {
    console.log(`${ts()}: [Resume] Randomness present; will continue drawing.`);
  }
}

// Tek seferde tek draw; zincirde değişimi kontrol et
let drawLock = false;
async function tryDraw(rid) {
  if (drawLock) return;
  drawLock = true;
  try {
    const before = parseRoundInfo(await bingo.roundInfo(rid));
    if (before.finalized || before.drawCount >= MAX_NUMBER || before.randomness === 0n) return;

    console.log(`${ts()}: [loop] Draw (${before.drawCount + 1}/${MAX_NUMBER}) for ${rid}`);
    const rc = await sendReplaceable((ov) => bingo.drawNext(rid, ov), `Draw(${rid})`);

    // tx mining olmadıysa rc=null dönmüş olabilir; zincirden teyit et
    const after = parseRoundInfo(await bingo.roundInfo(rid));
    if (after.drawCount <= before.drawCount) {
      console.warn(`${ts()}: [loop] drawCount unchanged; will retry in loop`);
    }
  } finally {
    drawLock = false;
  }
}

// Watchdog: uzun süre değişim yoksa tetikle
let lastProgressTs = Date.now();
async function heartbeat(rid) {
  try {
    const inf = parseRoundInfo(await bingo.roundInfo(rid));
    const prog = `${inf.finalized?'F':inf.drawCount}`;
    if (!heartbeat._last || heartbeat._last !== prog) {
      heartbeat._last = prog;
      lastProgressTs = Date.now();
    }
    const stalledSec = Math.floor((Date.now() - lastProgressTs)/1000);
    if (stalledSec > 45) {
      console.warn(`${ts()}: [watchdog] stalled ${stalledSec}s, checking state...`);
      if (inf.randomness !== 0n && !inf.finalized && inf.drawCount < MAX_NUMBER) {
        await tryDraw(rid);
      }
      lastProgressTs = Date.now();
    }
  } catch (e) {
    console.warn(`${ts()}: [watchdog] ${msg(e)}`);
  }
}

function attachEventListeners() {
  bingo.on('VRFFulfilled', async (roundId, _randomness) => {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] VRF ${rid}`);
    await tryDraw(rid);
  });
  bingo.on('Draw', async (roundId, _n, _i) => {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] Draw ${rid}`);
    lastProgressTs = Date.now();
    await tryDraw(rid); // bir sonrakine geç
  });
  bingo.on('Payout', async (roundId) => {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] Payout ${rid}`);
    const info = parseRoundInfo(await retry(() => bingo.roundInfo(rid)));
    await createNextRound(info.entryFee);
  });
  bingo.on('RoundCreated', (roundId) => {
    console.log(`${ts()}: [event] RoundCreated ${Number(roundId)}`);
  });
}

async function mainLoop() {
  await waitProviderHealthy();
  await ensureNextRoundExists();
  await resumeIfInMiddle();
  attachEventListeners();

  while (true) {
    try {
      const rid  = Number(await retry(() => bingo.currentRoundId()));
      if (rid === 0) { await sleep(2000); continue; }
      const info = parseRoundInfo(await retry(() => bingo.roundInfo(rid)));
      const now  = Math.floor(Date.now() / 1000);

      if (info.finalized) {
        console.log(`${ts()}: [loop] Round ${rid} finalized → creating next...`);
        await createNextRound(info.entryFee);
        await sleep(3000);
        continue;
      }
      if (now < info.startTime) { await sleep(1000); continue; }

      if (!info.vrfRequested && now > info.joinDeadline) {
        console.log(`${ts()}: [loop] Request VRF for ${rid}`);
        await sendReplaceable((ov) => bingo.requestRandomness(rid, ov), `VRF(${rid})`);
        await sleep(1500);
        continue;
      }

      if (info.randomness !== 0n && info.drawCount < MAX_NUMBER) {
        await tryDraw(rid);
        const interval = Math.max(1, info.drawInterval || DEFAULT_DRAW_INTERVAL);
        await sleep(interval * 1000);
        await heartbeat(rid);
        continue;
      }

      await heartbeat(rid);
      await sleep(POLL_MS);
    } catch (e) {
      console.error(`${ts()}: [loop] error: ${msg(e)}`);
      await sleep(4000);
    }
  }
}

mainLoop().catch((e) => {
  console.error(`${ts()}: FATAL ${msg(e)}`);
  process.exit(1);
});
