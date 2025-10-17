// autoloop.js — Base Mainnet • resilient loop (auto-next-round on no-winner) • Ethers v6
import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';

// ===== ENV =====
const RPC       = process.env.RPC_URL;
const PK        = process.env.SYSTEM_PK;
const CONTRACT  = process.env.CONTRACT;

const MAX_NUMBER = 90;
const DEFAULT_JOIN_WINDOW_SEC = 240;
const DEFAULT_DRAW_INTERVAL   = 5;
const POLL_MS                 = 1500;
const TX_TIMEOUT_MS           = 20000;
const FEE_BUMP_NUM            = 130n;
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

// ===== Utils =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const msg = (e) => e?.shortMessage ?? e?.info?.error?.message ?? e?.message ?? String(e);

// ---- Fee helpers ----
const MIN_PRIORITY = 100_000n; // 0.1 gwei
const MIN_FEE      = 500_000n; // 0.5 gwei
function bump(n){ return (n * FEE_BUMP_NUM) / FEE_BUMP_DEN; }
async function getSafeFees(){
  const fd = await provider.getFeeData();
  let p = fd.maxPriorityFeePerGas ?? MIN_PRIORITY;
  let f = fd.maxFeePerGas ?? MIN_FEE;
  if(p < MIN_PRIORITY) p = MIN_PRIORITY;
  if(f < MIN_FEE)      f = MIN_FEE;
  const b = (await provider.getBlock('latest'))?.baseFeePerGas ?? 0n;
  const safe = b*2n + p;
  if(f < safe) f = safe;
  return { maxPriorityFeePerGas: p, maxFeePerGas: f };
}

// ---- Replacement pool (per logical slot) ----
const pendingSlots=new Map();
async function sendReplaceable(label, buildTx, slotKey=label){
  let slot = pendingSlots.get(slotKey);
  if(!slot){
    const nonce = await provider.getTransactionCount(await signer.getAddress(),'pending');
    const fees  = await getSafeFees();
    slot = { nonce, ...fees };
    pendingSlots.set(slotKey, slot);
  }
  for(let i=0;i<12;i++){
    try{
      const txReq = await buildTx({
        nonce: slot.nonce,
        maxPriorityFeePerGas: slot.maxPriorityFeePerGas,
        maxFeePerGas:         slot.maxFeePerGas
      });
      const tx = await signer.sendTransaction(txReq);
      console.log(`${ts()}: [loop] ${label} tx=${tx.hash} nonce=${slot.nonce}`);
      const rc = await provider.waitForTransaction(tx.hash, 1, TX_TIMEOUT_MS);
      if(!rc){
        console.warn(`${ts()}: [sendReplaceable] timeout`);
        slot.maxPriorityFeePerGas = bump(slot.maxPriorityFeePerGas);
        slot.maxFeePerGas         = bump(slot.maxFeePerGas);
        continue;
      }
      if(rc.status !== 1) throw new Error(`${label} reverted`);
      pendingSlots.delete(slotKey);
      return rc;
    }catch(e){
      const m = msg(e);
      if(m.includes('underpriced') || m.includes('replacement') ){
        slot.maxPriorityFeePerGas = bump(slot.maxPriorityFeePerGas);
        slot.maxFeePerGas         = bump(slot.maxFeePerGas);
        continue;
      }
      if(m.includes('nonce too low') || m.includes('NONCE_EXPIRED')){
        pendingSlots.delete(slotKey);
        return null; // state üstten teyit edilecek
      }
      if(m.includes('insufficient funds') || m.includes('intrinsic transaction cost')){
        console.error(`${ts()}: [funds] ${m}`);
        throw e;
      }
      console.warn(`${ts()}: [sendReplaceable] ${m}`);
      slot.maxPriorityFeePerGas = bump(slot.maxPriorityFeePerGas);
      slot.maxFeePerGas         = bump(slot.maxFeePerGas);
    }
  }
  pendingSlots.delete(slotKey);
  throw new Error(`${label} failed after multiple replacements`);
}

// ---- Round parsing ----
function parseRoundInfo(i){
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

// ---- Game control ----
async function createNextRound(entryFee){
  const now = Math.floor(Date.now()/1000);
  await sendReplaceable(
    `CreateNext(${now+10})`,
    (ov)=> bingo.createRound.populateTransaction(
      BigInt(now + 10),
      BigInt(DEFAULT_JOIN_WINDOW_SEC),
      BigInt(DEFAULT_DRAW_INTERVAL),
      entryFee,
      ov
    ),
    'createNext'
  );
  console.log(`${ts()}: [Next] Round scheduled`);
}

async function ensureNextRoundExists(){
  const rid = Number(await bingo.currentRoundId());
  if(rid === 0){
    console.log(`${ts()}: [Init] No rounds yet`);
    await createNextRound(1_000_000n); // 1 USDC
  }
}

// ---- Auto-claim (winner scan) ----
async function scanAndClaim(rid){
  try{
    const info = parseRoundInfo(await bingo.roundInfo(rid));
    if(info.finalized || info.randomness === 0n) return false;

    const players = await bingo.playersOf(rid);
    if(!players || players.length === 0){
      // oyuncu yok → eğer tüm sayılar çekildiyse yeni raund aç
      if(info.drawCount >= MAX_NUMBER && !info.finalized){
        console.log(`${ts()}: [claim] No players & all drawn → start next round`);
        await createNextRound(info.entryFee);
        return true;
      }
      return false;
    }

    for(const p of players){
      try{
        const can = await bingo.canClaimBingo(rid, p);
        if(can){
          console.log(`${ts()}: [claim] ${p}`);
          const rc = await sendReplaceable(
            `Claim(${rid},${p})`,
            (ov)=> bingo.claimBingoFor.populateTransaction(rid, p, ov),
            `claim-${rid}`
          );
          if(rc) return true;
        }
      }catch(e){
        console.warn(`${ts()}: [claim] check ${p} err: ${msg(e)}`);
      }
    }

    // kimse kazanamadı ve 90/90 olduysa → yeni round (kontrat finalize etmiyor)
    if(info.drawCount >= MAX_NUMBER && !info.finalized){
      console.log(`${ts()}: [claim] No winner after all draws → starting next round`);
      await createNextRound(info.entryFee);
      return true;
    }
  }catch(e){
    console.warn(`${ts()}: [claim] ${msg(e)}`);
  }
  return false;
}

// ---- Draw (simulate before sending) ----
let drawLock=false;
async function tryDraw(rid){
  if(drawLock) return;
  drawLock = true;
  try{
    // önce kazan var mı?
    if(await scanAndClaim(rid)) return;

    const before = parseRoundInfo(await bingo.roundInfo(rid));
    if(before.finalized || before.randomness === 0n) return;

    // too early / all numbers? – simulate
    try{
      await bingo.getFunction('drawNext').staticCall(rid);
    }catch(e){
      const m = msg(e);
      if(m.includes('too early')){
        console.warn(`${ts()}: [simulate] too early`);
        return;
      }
      if(m.includes('all numbers') || m.includes('all numbers drawn')){
        console.warn(`${ts()}: [simulate] all numbers drawn`);
        // fail-safe: yeni round
        const info = parseRoundInfo(await bingo.roundInfo(rid));
        if(!info.finalized) await createNextRound(info.entryFee);
        return;
      }
      console.warn(`${ts()}: [simulate] ${m}`);
      return;
    }

    console.log(`${ts()}: [loop] Draw (${before.drawCount + 1}/${MAX_NUMBER}) for ${rid}`);
    const rc = await sendReplaceable(
      `Draw(${rid})`,
      (ov)=> bingo.drawNext.populateTransaction(rid, ov),
      `draw-${rid}`
    );

    if(rc === null){
      const a = parseRoundInfo(await bingo.roundInfo(rid));
      if(a.drawCount <= before.drawCount) console.warn(`${ts()}: drawCount unchanged`);
    }

    // çekimden sonra yine kontrol
    await scanAndClaim(rid);
  }finally{
    drawLock = false;
  }
}

// ---- Watchdog ----
let lastProgressTs=Date.now();
async function heartbeat(rid){
  try{
    const inf = parseRoundInfo(await bingo.roundInfo(rid));
    const prog = `${inf.finalized?'F':inf.drawCount}`;
    if(!heartbeat._last || heartbeat._last !== prog){
      heartbeat._last = prog;
      lastProgressTs = Date.now();
    }
    const stalledSec = Math.floor((Date.now()-lastProgressTs)/1000);
    if(stalledSec > 45){
      console.warn(`${ts()}: [watchdog] stalled ${stalledSec}s`);
      const claimed = await scanAndClaim(rid);
      if(!claimed && inf.randomness !== 0n && !inf.finalized && inf.drawCount < MAX_NUMBER){
        await tryDraw(rid);
      }
      lastProgressTs = Date.now();
    }
  }catch(e){
    console.warn(`${ts()}: [watchdog] ${msg(e)}`);
  }
}

// ---- Events ----
function attachEventListeners(){
  bingo.on('VRFFulfilled', async (roundId)=> {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] VRF ${rid}`);
    await tryDraw(rid);
  });
  bingo.on('Draw', async (roundId)=> {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] Draw ${rid}`);
    lastProgressTs = Date.now();
    const i = parseRoundInfo(await bingo.roundInfo(rid));
    if(i.drawCount >= MAX_NUMBER && !i.finalized){
      // güvenlik: tüm sayılar çekilmiş → yeni raund
      await createNextRound(i.entryFee);
      return;
    }
    await tryDraw(rid); // bir sonraki
  });
  bingo.on('Payout', async (roundId)=> {
    const rid = Number(roundId);
    console.log(`${ts()}: [event] Payout ${rid}`);
    const i = parseRoundInfo(await bingo.roundInfo(rid));
    await createNextRound(i.entryFee);
  });
  bingo.on('RoundCreated', (roundId)=> {
    console.log(`${ts()}: [event] RoundCreated ${Number(roundId)}`);
  });
}

// ---- Main loop ----
async function mainLoop(){
  const net = await provider.getNetwork();
  console.log(`${ts()}: [startup] chainId=${Number(net.chainId)}`);
  if(Number(net.chainId) !== 8453) throw new Error('Wrong network (need Base mainnet)');
  // bytecode check
  const code = await provider.getCode(CONTRACT);
  if(!code || code === '0x') throw new Error(`No bytecode at ${CONTRACT}`);

  await ensureNextRoundExists();
  attachEventListeners();

  while(true){
    try{
      const rid = Number(await bingo.currentRoundId());
      if(rid === 0){ await sleep(2000); continue; }

      const info = parseRoundInfo(await bingo.roundInfo(rid));
      const now  = Math.floor(Date.now()/1000);

      if(info.finalized){
        await createNextRound(info.entryFee);
        await sleep(3000);
        continue;
      }

      // kimse join etmediyse ve join bitti ise: VRF isteme, direkt yeni round
      if(!info.vrfRequested && now > info.joinDeadline){
        const players = await bingo.playersOf(rid);
        if(!players || players.length === 0){
          console.log(`${ts()}: [loop] No players; skipping VRF → start next`);
          await createNextRound(info.entryFee);
          await sleep(1500);
          continue;
        }
      }

      if(now < info.startTime){ await sleep(1000); continue; }

      if(!info.vrfRequested && now > info.joinDeadline){
        console.log(`${ts()}: [loop] Request VRF for ${rid}`);
        // simulate: sadece güvenlik (çok gerekli değil)
        try{
          await bingo.getFunction('requestRandomness').staticCall(rid);
        }catch(e){
          const m = msg(e);
          if(m.includes('already requested')){ /* ignore */ }
          else if(m.includes('join not ended')){ await sleep(1000); continue; }
          else { console.warn(`${ts()}: [simulate VRF] ${m}`); }
        }
        await sendReplaceable(
          `VRF(${rid})`,
          (ov)=> bingo.requestRandomness.populateTransaction(rid, ov),
          `vrf-${rid}`
        );
        await sleep(1500);
        continue;
      }

      // tüm sayılar çekilmiş ama finalize yok → yeni round
      if(info.randomness !== 0n && info.drawCount >= MAX_NUMBER && !info.finalized){
        console.log(`${ts()}: [loop] All numbers drawn & not finalized → start next`);
        await createNextRound(info.entryFee);
        await sleep(1500);
        continue;
      }

      if(info.randomness !== 0n && info.drawCount < MAX_NUMBER){
        if(!(await scanAndClaim(rid))){
          await tryDraw(rid);
          await sleep(Math.max(1, info.drawInterval || DEFAULT_DRAW_INTERVAL) * 1000);
        }
        await heartbeat(rid);
        continue;
      }

      await heartbeat(rid);
      await sleep(POLL_MS);
    }catch(e){
      console.error(`${ts()}: [loop] ${msg(e)}`);
      await sleep(4000);
    }
  }
}

mainLoop().catch(e=>{console.error(`${ts()}: FATAL ${msg(e)}`);process.exit(1);});
