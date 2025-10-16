// autoloop.js — Node 18+, Ethers v6 (auto-claim-for + rolling rounds)
import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';

const RPC       = process.env.RPC_URL;
const PK        = process.env.SYSTEM_PK;
const CONTRACT  = process.env.CONTRACT;

const MAX_NUMBER = 90;
const DEFAULT_JOIN_WINDOW_SEC = 120;  // 2 minutes
const DEFAULT_DRAW_INTERVAL   = 1;    // 1 second
const POLL_MS                 = 1500;
const AFTER_90_COOLDOWN_MS    = 3000;

if (!RPC || !PK || !CONTRACT) {
  console.error('Missing env. Required: RPC_URL, SYSTEM_PK, CONTRACT');
  process.exit(1);
}

const abiPath = path.join(process.cwd(), 'BaseBingo25.abi.json');
if (!fs.existsSync(abiPath)) {
  console.error(`ABI not found at ${abiPath}`);
  process.exit(1);
}
const bingoAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));

const provider = new JsonRpcProvider(RPC);
const signer   = new Wallet(PK, provider);
const bingo    = new Contract(CONTRACT, bingoAbi, signer);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, tries = 5, baseMs = 600) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const wait = baseMs * Math.pow(2, i);
      console.warn(`[retry ${i+1}/${tries}] ${e?.shortMessage ?? e?.message ?? e} — waiting ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function startupChecks() {
  const net = await retry(() => provider.getNetwork());
  console.log(`[startup] chainId=${Number(net.chainId)} (hex: 0x${Number(net.chainId).toString(16)})`);
  console.log(`[startup] CONTRACT=${CONTRACT}`);
  const code = await retry(() => provider.getCode(CONTRACT));
  if (!code || code === '0x') throw new Error(`No bytecode at ${CONTRACT} on this chain.`);
}

async function createNextRound(entryFee) {
  const now = Math.floor(Date.now() / 1000);
  const tx = await retry(() => bingo.createRound(
    BigInt(now + 10),
    BigInt(DEFAULT_JOIN_WINDOW_SEC),
    BigInt(DEFAULT_DRAW_INTERVAL),
    entryFee
  ));
  await tx.wait();
  console.log(`[next] Round created for t=${now + 10}`);
}

async function ensureNextRoundExists() {
  const rid = Number(await retry(() => bingo.currentRoundId()));
  if (rid === 0) {
    console.log('[init] No rounds. Creating first one...');
    await createNextRound(1_000_000n); // 1 USDC
  }
}

function parseRound(info) {
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

async function tryAutoClaim(rid) {
  const players = await retry(() => bingo.playersOf(rid));
  if (!players || players.length === 0) return false;

  for (const p of players) {
    const ok = await retry(() => bingo.canClaimBingo(rid, p));
    if (ok) {
      console.log(`[claim] Auto-claiming for ${p} in round ${rid}...`);
      try {
        const tx = await retry(() => bingo.claimBingoFor(rid, p));
        await tx.wait();
        console.log(`[claim] Success for ${p} (round ${rid})`);
        return true; // finalized; stop checking others
      } catch (e) {
        // If another tx just finalized, this will revert; we just ignore and continue
        console.warn(`[claim] claimBingoFor failed (maybe already claimed):`, e?.shortMessage ?? e?.message ?? e);
      }
    }
  }
  return false;
}

async function resumeIfNeeded() {
  const rid  = Number(await retry(() => bingo.currentRoundId()));
  const info = parseRound(await retry(() => bingo.roundInfo(rid)));
  const now  = Math.floor(Date.now() / 1000);

  if (info.finalized) {
    console.log(`[resume] Round ${rid} finalized. Spawning next...`);
    await createNextRound(info.entryFee);
    return;
  }

  if (!info.vrfRequested && now > info.joinDeadline) {
    console.log(`[resume] Join closed for ${rid}. Requesting VRF...`);
    const tx = await retry(() => bingo.requestRandomness(rid));
    await tx.wait();
  }

  if (info.randomness !== 0n && info.drawCount > 0) {
    await tryAutoClaim(rid);
  }

  if (info.randomness !== 0n && info.drawCount >= MAX_NUMBER && !info.finalized) {
    console.log(`[resume] 90/90 reached without finalize. Creating next...`);
    await sleep(AFTER_90_COOLDOWN_MS);
    await createNextRound(info.entryFee);
  }
}

function attachEventLogs() {
  bingo.on('RoundCreated', (roundId, startTime, entryFeeUSDC) => {
    console.log(`[event] RoundCreated id=${roundId} start=${startTime} entry=${entryFeeUSDC}`);
  });

  bingo.on('VRFFulfilled', (roundId) => {
    console.log(`[event] VRFFulfilled round=${Number(roundId)}`);
  });

  bingo.on('Draw', async (roundId) => {
    const rid = Number(roundId);
    console.log(`[event] Draw round=${rid}`);
    try {
      await tryAutoClaim(rid);
    } catch (e) {
      console.warn(`[event] auto-claim error:`, e?.shortMessage ?? e?.message ?? e);
    }
  });

  bingo.on('Payout', async (roundId, winner, winnerUSDC, feeUSDC) => {
    const rid = Number(roundId);
    console.log(`[event] Payout round=${rid} winner=${winner} win=${winnerUSDC} fee=${feeUSDC}`);
    try {
      const info = parseRound(await retry(() => bingo.roundInfo(rid)));
      await createNextRound(info.entryFee);
    } catch (e) {
      console.error('[event:Payout] error:', e?.shortMessage ?? e?.message ?? e);
    }
  });
}

async function loop() {
  await startupChecks();
  await ensureNextRoundExists();
  await resumeIfNeeded();
  attachEventLogs();

  while (true) {
    try {
      const rid  = Number(await retry(() => bingo.currentRoundId()));
      const info = parseRound(await retry(() => bingo.roundInfo(rid)));
      const now  = Math.floor(Date.now() / 1000);

      if (info.finalized) {
        console.log(`[loop] Round ${rid} finalized → next`);
        await createNextRound(info.entryFee);
        await sleep(3000);
        continue;
      }

      if (now < info.startTime) {
        await sleep(1000);
        continue;
      }

      if (!info.vrfRequested && now > info.joinDeadline) {
        console.log(`[loop] Join closed for ${rid} → request VRF`);
        const tx = await retry(() => bingo.requestRandomness(rid));
        await tx.wait();
        await sleep(2000);
        continue;
      }

      if (info.randomness !== 0n && info.drawCount < MAX_NUMBER) {
        console.log(`[loop] Draw (${info.drawCount + 1}/${MAX_NUMBER}) for ${rid}`);
        const tx = await retry(() => bingo.drawNext(rid));
        await tx.wait();
        // after each draw, try auto-claim
        await tryAutoClaim(rid);
        await sleep(Math.max(1000, info.drawInterval * 1000));
        continue;
      }

      if (info.randomness !== 0n && info.drawCount >= MAX_NUMBER && !info.finalized) {
        console.log(`[loop] 90/90 reached without finalize → next round`);
        await sleep(AFTER_90_COOLDOWN_MS);
        await createNextRound(info.entryFee);
        await sleep(3000);
        continue;
      }

      await sleep(POLL_MS);
    } catch (e) {
      console.error('[loop] error:', e?.shortMessage ?? e?.message ?? e);
      await sleep(4000);
    }
  }
}

loop().catch((e) => {
  console.error(e);
  process.exit(1);
});
