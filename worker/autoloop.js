// autoloop.js — Base Mainnet • Node 18+ • Ethers v6
import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
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

const TX_TIMEOUT_MS           = 20_000; // replacement için kısa tut
const FEE_BUMP_NUM            = 130n;   // %30
const FEE_BUMP_DEN            = 100n;

// ===== ABI =====
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
const signer   = new Wallet(PK, provider);
const bingo    = new Contract(CONTRACT, bingoAbi, signer);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const msg = (e) => e?.shortMessage ?? e?.message ?? String(e);

async function waitProviderHealthy() {
  const net = await provider.getNetwork();
  console.log(`${ts()}: [startup] chainId=${Number(net.chainId)} (hex: 0x${Number(net.chainId).toString(16)})`);
  if (Number(net.chainId) !== 8453) {
    throw new Error(`Wrong network. Expected Base mainnet (8453). Got ${Number(net.chainId)}.`);
  }
  console.log(`${ts()}: [startup] CONTRACT=${CONTRACT}`);
  const code = await provider.getCode(CONTRACT);
  if (!code || code === '0x') throw new Error(`No bytecode at ${CONTRACT}`);
}

// ---- Fee helpers (EIP-1559) ----
const MIN_PRIORITY = 100_000n;   // 0.1 gwei
const MIN_FEE      = 500_000n;   // 0.5 gwei

function bump(n) {
  return (n * FEE_BUMP_NUM) / FEE_BUMP_DEN;
}

async function getSafeFees() {
  const fd = await provider.getFeeData();
  let maxPriorityFeePerGas = fd.maxPriorityFeePerGas ?? MIN_PRIORITY;
  let maxFeePerGas         = fd.maxFeePerGas ?? MIN_FEE;

  if (maxPriorityFeePerGas < MIN_PRIORITY) maxPriorityFeePerGas = MIN_PRIORITY;
  if (maxFeePerGas < MIN_FEE) maxFeePerGas = MIN_FEE;

  const block = await provider.getBlock('latest');
  const base  = (block?.baseFeePerGas ?? 0n);
  const safe  = base * 2n + maxPriorityFeePerGas;
  if (maxFeePerGas < safe) maxFeePerGas = safe;

  return { maxPriorityFeePerGas, maxFeePerGas };
}

// ====== REPLACEABLE TX (AYNI NONCE) ======
// nonceKey -> aktif nonce & current fees
const pendingSlots = new Map();
/**
 * sendReplaceableStrict:
 *  - Aynı nonce ile replace eder (gerçek replacement)
 *  - Timeout/underpriced'ta fee bump ve tekrar
 *  - NONCE_EXPIRED ise zinciri üst katman kontrol eder
 */
async function sendReplaceableStrict(label, buildTx, nonceKey = label) {
  // slot al / oluştur
  let slot = pendingSlots.get(nonceKey);
  if (!slot) {
    const startNonce = await provider.getTransactionCount(await signer.getAddress(), 'pending');
    const fees = await getSafeFees();
    slot = {
      nonce: startNonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
    };
    pendingSlots.set(nonceKey, slot);
  }

  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const txReq = await buildTx({
        nonce: slot.nonce,
        maxPriorityFeePerGas: slot.maxPriorityFeePerGas,
        maxFeePerGas: slot.maxFeePerGas,
      });
      const tx = await signer.sendTransaction(txReq);
      console.log(`${ts()}: [loop] ${label} tx=${tx.hash} nonce=${slot.nonce} p=${slot.maxPriorityFeePerGas} f=${slot.maxFeePerGas}`);

      const rc = await provider.waitForTransaction(tx.hash, 1, TX_TIMEOUT_MS);
      if (!rc) {
        console.warn(`${ts()}: [sendReplaceable] timeout`);
        // fee bump ve tekrar (aynı nonce)
        slot.maxPriorityFeePerGas = bump(slot.maxPriorityFeePerGas);
        slot.maxFeePerGas         = bump(slot.maxFeePerGas);
        continue;
      }
      if (rc.status !== 1) throw new Error(`${label} reverted`);
      // başarı → slot’ı bırak
      pendingSlots.delete(nonceKey);
      return rc;
    } catch (e) {
      const m = msg(e);
      if (m.includes('replacement transaction underpriced') || m.includes('UNDERPRICED')) {
        slot.maxPriorityFeePerGas = bump(slot.maxPriorityFeePerGas);
        slot.maxFeePerGas         = bump(slot.maxFeePerGas);
        console.warn(`${ts()}: [replace] underpriced → bump & retry`);
        continue;
      }
      if (m.includes('nonce too low') || m.includes('NONCE_EXPIRED')) {
        // Önceki tx muhtemelen zincirde. Slotu bırak; üst katman zinciri kontrol etsin.
        console.warn(`${ts()}: [nonce] expired/low → state check`);
        pendingSlots.delete(nonceKey);
        return null;
      }
      if (m.includes('insufficient funds') || m.includes('intrinsic transaction cost')) {
        console.error(`${ts()}: [funds] ${m}`);
        pendingSlots.delete(nonceKey);
        throw e;
      }
      console.warn(`${ts()}: [sendReplaceable] ${m} → bump & retry`);
      slot.maxPriorityFeePerGas = bump(slot.maxPriorityFeePerGas);
      slot.maxFeePerGas         = bump(slot.maxFeePerGas);
    }
  }
  pendingSlots.delete(nonceKey);
  throw new Error(`${label} failed after many replacements`);
}

// ---- Game utils ----
function parseRoundInfo(i) {
  return {
    startTime:    Number(i[0]),
    joinDeadline: Number(i[1]),
    drawInterval: Number(i[2]),
    entryFee:     i[3],
    vrfRequested: Boolean(i[4]),
    randomness:   BigInt(i[5]),
    drawnMask:    i[6],
    drawCount:    Number(i[7]),
    lastDrawTime: Number(i[8]),
    finalized:    Boolean(i[9]),
    winner:       String(i[10]),
    prizePool:    i[11],
  };
}

async function createNextRound(entryFee) {
  const now = Math.floor(Date.now() / 1000);
  await sendReplaceableStrict(
    `CreateNext(start=${now+10})`,
    (ov) => bingo.createRound.populateTransaction(BigInt(now + 10), BigInt(DEFAULT_JOIN_WINDOW_SEC), BigInt(DEFAULT_DRAW_INTERVAL), entryFee, ov),
    'createNext'
  );
  console.log(`${ts()}: [Next] Round scheduled`);
}

async function ensureNextRoundExists() {
  const rid = Number(await bingo.currentRoundId());
  if (rid === 0) {
    console.log(`${ts()}: [Init] No rounds yet. Creating the first one...`);
    await createNextRound(1_000_000n); // 1 USDC
  }
}

async function resumeIfInMiddle() {
  const rid  = Number(await bingo.currentRoundId());
  if (rid === 0) return;
  const info = parseRoundInfo(await bingo.roundInfo(rid));
  const now  = Math.floor(Date.now() / 1000);

  if (info.finalized) {
    console.log(`${ts()}: [Resume] Round ${rid} finalized. Creating next...`);
    await createNextRound(info.entryFee);
    return;
  }
  if (!info.vrfRequested && now > info.joinDeadline) {
    console.log(`${ts()}: [Resume] Requesting VRF for ${rid}...`);
    await sendReplaceableStrict(
      `VRF(${rid})`,
      (ov) => bingo.requestRandomness.populateTransaction(rid, ov),
      `vrf:${rid}`
    );
  }
  if (info.randomness !== 0n && info.drawCount < MAX_NUMBER) {
    console.log(`${ts()}: [Resume] Randomness present; will continue drawing.`);
  }
}

// ---- Auto-claim ----
async function scanAndClaim(rid) {
  try {
    const info = parseRoundInfo(await bingo.roundInfo(rid));
    if (info.finalized || info.randomness === 0n) return false;

    const players = await bingo.playersOf(rid);
    if (!players || players.length === 0) return false;

    for (const p of players) {
      try {
        const can = await bingo.canClaimBingo(rid, p);
        if (can) {
          console.log(`${ts()}: [claim] Detected bingo for ${p}, claiming...`);
          const rc = await sendReplaceableStrict(
            `Claim(${rid},${p})`,
            (ov) => bingo.claimBingoFor.populateTransaction(rid, p, ov),
            `claim:${rid}`
          );
          if (rc === null) {
            const after = parseRoundInfo(await bingo.roundInfo(rid));
            if (after.finalized) {
              console.log(`${ts()}: [claim] Round ${rid} finalized by previous tx.`);
              return true;
            }
          } else {
            console.log(`${ts()}: [claim] Claimed for ${p}, round ${rid} finalized.`);
            return true;
          }
        }
      } catch (e) {
        console.warn(`${ts()}: [claim] check ${p} err: ${msg(e)}`);
      }
    }
  } catch (e) {
    console.warn(`${ts()}: [claim] scan error: ${msg(e)}`);
  }
  return false;
}

// ---- Draw (simulate + replaceable) ----
let drawLock = false;
async function tryDraw(rid) {
  if (drawLock) return;
  drawLock = true;
  try {
    // önce auto-claim
    const claimedBefore = await scanAndClaim(rid);
    if (claimedBefore) return;

    const before = parseRoundInfo(await bingo.roundInfo(rid));
    if (before.finalized || before.randomness === 0n || before.drawCount >= MAX_NUMBER) return;

    // too-early vb revert’i önlemek için simulate
    try {
      // ethers v6: simulate
      await bingo.simulate.drawNext(rid);
    } catch (e) {
      const m = msg(e);
      if (m.includes('too early') || m.includes('round ended')) {
        // bekle ve çık
        return;
      }
      // başka bir revert sebebi varsa logla
      console.warn(`${ts()}: [simulate] drawNext revert: ${m}`);
      return;
    }

    console.log(`${ts()}: [loop] Draw (${before.drawCount + 1}/${MAX_NUMBER}) for ${rid}`);
    const rc = await sendReplaceableStrict(
      `Draw(${rid})`,
      (ov) => bingo.drawNext.populateTransaction(rid, ov),
      `draw:${rid}`
    );

    // nonce expired/null ise zinciri okuyup devam
    const after = parseRoundInfo(await bingo.roundInfo(rid));
    if (after.drawCount <= before.drawCount) {
      console.warn(`${ts()}: [loop] drawCount unchanged; will retry in loop`);
    }

    // çekimden sonra yine auto-claim
    await scanAndClaim(rid);
  } finally {
    drawLock = false;
  }
}

// ---- Watchdog ----
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
      const claimed = await scanAndClaim(rid);
      if (!claimed && inf.randomness !== 0n && !inf.finalized && inf.drawCount < MAX_NUMBER) {
        await tryDraw(rid);
      }
      lastProgressTs = Date.now();
    }
  } catch (e) {
    console.warn(`${ts()}: [watchdog] ${msg(e)}`);
  }
}

function attachEventListeners() {
  bingo.on('VRFFulfilled', async (roundId) => {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] VRF ${rid}`);
    await scanAndClaim(rid);
    await tryDraw(rid);
  });
  bingo.on('Draw', async (roundId) => {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] Draw ${rid}`);
    lastProgressTs = Date.now();
    const claimed = await scanAndClaim(rid);
    if (!claimed) await tryDraw(rid);
  });
  bingo.on('Payout', async (roundId) => {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] Payout ${rid}`);
    const info = parseRoundInfo(await bingo.roundInfo(rid));
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
      const rid  = Number(await bingo.currentRoundId());
      if (rid === 0) { await sleep(2000); continue; }
      const info = parseRoundInfo(await bingo.roundInfo(rid));
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
        await sendReplaceableStrict(
          `VRF(${rid})`,
          (ov) => bingo.requestRandomness.populateTransaction(rid, ov),
          `vrf:${rid}`
        );
        await sleep(1500);
        continue;
      }

      if (info.randomness !== 0n && info.drawCount < MAX_NUMBER) {
        const claimed = await scanAndClaim(rid);
        if (!claimed) {
          await tryDraw(rid);
          const interval = Math.max(1, info.drawInterval || DEFAULT_DRAW_INTERVAL);
          await sleep(interval * 1000);
        }
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
