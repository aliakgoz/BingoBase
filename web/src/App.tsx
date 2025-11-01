import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sdk } from "@farcaster/miniapp-sdk";

import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  WebSocketProvider,
  formatUnits,
  parseUnits,
} from "ethers";

// ===== ENV =====
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS as string;
const USDC_ADDRESS     = import.meta.env.VITE_USDC_ADDRESS as string;
const RPC_URL          = (import.meta.env.VITE_RPC_URL as string) || "";
const RPC_WSS          = (import.meta.env.VITE_RPC_WSS as string) || "";
const CHAT_WSS         = (import.meta.env.VITE_CHAT_WSS as string) || "";

// ===== CONSTS =====
const EXPLORER = "https://basescan.org"; // Base mainnet
const LAST_LOG_LOOKBACK = 20000;          // how many blocks back to search for Draw logs

// ===== THEME =====
const THEME_BG = "#0b0f14";
const THEME_TEXT = "#e7eef7";
const THEME_MUTED = "#8ea0b3";
const CARD_BG = "#121a23";
const CARD_BORDER = "#1e2a38";
const CARD_SHADOW = "0 2px 10px rgba(0,0,0,.25)";
const CHIP_BG = "#0e1620";

const ACTIVE_GREEN = "#00C853";
const ACTIVE_GREEN_TEXT = "#eafff2";
const DRAWN_BLUE = "#1B4BFF";
const DRAWN_BLUE_TEXT = "#eaf0ff";
const BTN_PRIMARY_BG = "#1b5eff";
const BTN_PRIMARY_BG_DISABLED = "#2a3866";

const MAX_NUMBER  = 90;
const CARD_SIZE   = 24;

// fixed grid metrics
const CARD_CELL_H = 44;
const CARD_GAP    = 8;
const CARD_ROWS   = 4;
const CARD_MIN_H  = CARD_ROWS * CARD_CELL_H + (CARD_ROWS - 1) * CARD_GAP;

// ===== Minimal ABIs =====
const BINGO_ABI = [
  "function usdc() view returns (address)",
  "function currentRoundId() view returns (uint256)",
  "function playersOf(uint256) view returns (address[])",
  `function roundInfo(uint256) view returns (
    uint64 startTime,
    uint64 joinDeadline,
    uint64 drawInterval,
    uint256 entryFeeUSDC,
    bool    vrfRequested,
    uint256 randomness,
    uint256 drawnMask,
    uint8   drawCount,
    uint64  lastDrawTime,
    bool    finalized,
    address winner,
    uint256 prizePoolUSDC
  )`,
  `function cardOf(uint256 roundId, address player) view returns (uint8[${CARD_SIZE}])`,
  "function joinRound(uint256 roundId) external",
  "function requestRandomness(uint256 roundId) external",
  "function drawNext(uint256 roundId) external",
  "function claimBingo(uint256 roundId) external",
  "event Joined(uint256 indexed roundId, address indexed player, uint256 paidUSDC)",
  "event Draw(uint256 indexed roundId, uint8 number, uint8 drawIndex)",
  "event RoundCreated(uint256 indexed roundId, uint64 startTime, uint256 entryFeeUSDC)",
  "event Payout(uint256 indexed roundId, address indexed winner, uint256 winnerUSDC, uint256 feeUSDC)",
  "event VRFFulfilled(uint256 indexed roundId, uint256 randomness)"
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

type RoundInfo = {
  startTime: bigint;
  joinDeadline: bigint;
  drawInterval: bigint;
  entryFeeUSDC: bigint;
  vrfRequested: boolean;
  randomness: bigint;
  drawnMask: bigint;
  drawCount: number;
  lastDrawTime: bigint;
  finalized: boolean;
  winner: string;
  prizePoolUSDC: bigint;
};

// ---- Universal EIP-1193 Provider discovery ----
async function getMiniAppProvider(): Promise<any | null> {
  try {
    const isMini = await sdk.isInMiniApp?.();
    if (!isMini) return null;
    const p = sdk.wallet?.getEthereumProvider?.();
    return p || null;
  } catch { return null; }
}

function pickInjectedProvider(eth: any): any {
  const list = Array.isArray(eth?.providers) ? eth.providers : [eth].filter(Boolean);
  const by = (key: string) => list.find((p: any) => p?.[key]);
  return by("isMetaMask") || by("isCoinbaseWallet") || list[0] || null;
}

function waitForInjectedEthereum(timeoutMs = 2000): Promise<any | null> {
  return new Promise((resolve) => {
    const existing = (window as any).ethereum;
    if (existing) return resolve(pickInjectedProvider(existing));

    let done = false;
    const finish = (val: any) => { if (!done) { done = true; resolve(val); } };

    const onInit = () => finish(pickInjectedProvider((window as any).ethereum));
    window.addEventListener("ethereum#initialized", onInit as any, { once: true } as any);

    setTimeout(() => {
      window.removeEventListener("ethereum#initialized", onInit as any);
      finish((window as any).ethereum ? pickInjectedProvider((window as any).ethereum) : null);
    }, timeoutMs);
  });
}

function isMobileUA() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function useProviders() {
  const readWs = useMemo(
    () => (RPC_WSS ? new WebSocketProvider(RPC_WSS) : undefined),
    [RPC_WSS]
  );
  const readHttp = useMemo(
    () => (RPC_URL ? new JsonRpcProvider(RPC_URL) : undefined),
    [RPC_URL]
  );

  const [write, setWrite] = useState<BrowserProvider>();
  const [account, setAccount] = useState<string>("");
  const [chainId, setChainId] = useState<number | undefined>(undefined);

  useEffect(() => {
    (async () => {
      // 1) Mini-app içindeyse sadece SDK provider
      const miniProv = await getMiniAppProvider();
      let eip1193: any | null = null;

      if (miniProv) {
        eip1193 = miniProv;
      } else {
        // 2) Web/Chrome: injected provider'ı bekle/ayıklama
        eip1193 = await waitForInjectedEthereum(2000);
      }

      if (eip1193) {
        try {
          setWrite(new BrowserProvider(eip1193));
          // başlangıç durumu
          const accs = await eip1193.request?.({ method: "eth_accounts" }).catch(() => []);
          if (Array.isArray(accs) && accs.length) setAccount(accs[0]);
          const cid = await eip1193.request?.({ method: "eth_chainId" }).catch(() => null);
          if (cid) setChainId(Number(cid));
          // eventler
          const onAcc = (accs: string[]) => setAccount(Array.isArray(accs) && accs.length ? accs[0] : "");
          const onCid = (cid: string) => setChainId(Number(cid));
          eip1193.on?.("accountsChanged", onAcc);
          eip1193.on?.("chainChanged", onCid);
          return () => {
            eip1193.removeListener?.("accountsChanged", onAcc);
            eip1193.removeListener?.("chainChanged", onCid);
          };
        } catch (e) {
          console.warn("BrowserProvider init failed:", e);
        }
      }
    })();
  }, []);

  return { readWs, readHttp, write, account, setAccount, chainId, setChainId };
}

export default function App() {
  const { readWs, readHttp, write, account, setAccount, chainId, setChainId } = useProviders();

  // providers chosen
  const [readProviderName, setReadProviderName] = useState<string>("(unused)");
  const read = readWs ?? readHttp;
  useEffect(() => {
    sdk.actions.ready(); // splash -> hidden
    setReadProviderName(readWs ? "WSS" : (readHttp ? "HTTP" : "(none)"));
    if (!readWs && !readHttp) console.error("No RPC providers configured.");
  }, [readWs, readHttp]);

  // contracts
  const [bingo, setBingo]   = useState<Contract>();
  const [events, setEvents] = useState<Contract>();
  const [usdc, setUsdc]     = useState<Contract>();

  // state
  const [currentRoundId, setCurrentRoundId] = useState<number>(0);
  const [round, setRound]                   = useState<RoundInfo>();
  const [symbol, setSymbol]                 = useState<string>("USDC");
  const [decimals, setDecimals]             = useState<number>(6);
  const [allowance, setAllowance]           = useState<bigint>(0n);
  const [balance, setBalance]               = useState<bigint>(0n);
  const [joined, setJoined]                 = useState<boolean>(false);
  const [card, setCard]                     = useState<number[]>([]);
  const [hasCard, setHasCard]               = useState<boolean>(false);
  const [cardRoundId, setCardRoundId]       = useState<number>(0);
  const [loadingTx, setLoadingTx]           = useState<string>("");

  // drawn highlighting (only last = green)
  const [lastDrawn, setLastDrawn]           = useState<number | undefined>(undefined);

  // last 5 draws feed (not in chat)
  type Feed = { n: number; tx?: string; ts: number };
  const [drawFeed, setDrawFeed] = useState<Feed[]>([]);

  // winner / payout duyurusu
  type PayoutInfo = {
    roundId: number;
    winner: string;
    winnerUSDC: bigint;
    feeUSDC: bigint;
    tx?: string;
    ts: number;
  };
  const [lastPayout, setLastPayout] = useState<PayoutInfo | null>(null);

  // diagnostics
  const [latestBlock, setLatestBlock] = useState<number>(0);
  const [diag, setDiag] = useState<{ hasCode?: boolean; chainId?: number; msg?: string }>({});

  const pulling = useRef(false);
  const nowSec  = Math.floor(Date.now() / 1000);

  // === WATCHDOG & GAP-FILL state ===
  const lastEventAtRef = useRef<number>(Date.now());   // son canlı sinyal (ws block/event)
  const lastHandledBlockRef = useRef<number>(0);       // en son işlenen block

  // diagnose bytecode & chainId
  useEffect(() => {
    (async () => {
      try {
        if (!RPC_URL || !CONTRACT_ADDRESS) return;
        const p = new JsonRpcProvider(RPC_URL);
        const [net, code] = await Promise.all([p.getNetwork(), p.getCode(CONTRACT_ADDRESS)]);
        const hasCode = !!code && code !== "0x";
        setDiag({ hasCode, chainId: Number(net.chainId), msg: hasCode ? undefined : "No bytecode at VITE_CONTRACT_ADDRESS on this RPC" });
      } catch (e:any) {
        setDiag({ msg: e?.message ?? String(e) });
      }
    })();
  }, []);

  // derived
  const canJoin = useMemo(() => {
    if (!round) return false;
    const inWindow = Number(round.startTime) <= nowSec && nowSec < Number(round.joinDeadline);
    return inWindow && !joined && !round.finalized;
  }, [round, joined, nowSec]);

  const drawnSet = useMemo(() => {
    const set = new Set<number>();
    if (!round) return set;
    let mask = round.drawnMask;
    for (let n = 1; n <= MAX_NUMBER; n++) {
      const bit = 1n << BigInt(n - 1);
      if ((mask & bit) !== 0n) set.add(n);
    }
    return set;
  }, [round]);

  const allDrawnList = useMemo(
    () => Array.from(drawnSet).sort((a, b) => a - b),
    [drawnSet]
  );

  // init contracts
  useEffect(() => {
    if (read && CONTRACT_ADDRESS) setBingo(new Contract(CONTRACT_ADDRESS, BINGO_ABI, read));
    if (readWs && CONTRACT_ADDRESS) setEvents(new Contract(CONTRACT_ADDRESS, BINGO_ABI, readWs));
    else setEvents(undefined);
    if (read && USDC_ADDRESS) setUsdc(new Contract(USDC_ADDRESS, ERC20_ABI, read));
  }, [read, readWs, readProviderName]);

  // latest block ticker
  useEffect(() => {
    if (!read) return;
    let stop = false;
    const tick = async () => {
      try {
        const bn = await read.getBlockNumber();
        if (!stop) {
          setLatestBlock(bn);
          lastHandledBlockRef.current = Math.max(lastHandledBlockRef.current, Number(bn));
          lastEventAtRef.current = Date.now();
        }
      } catch {}
      if (!stop) setTimeout(tick, readWs ? 1000 : 3000);
    };
    tick();
    if (readWs) {
      const onBlock = (b: number) => {
        setLatestBlock(b);
        lastEventAtRef.current = Date.now();
        lastHandledBlockRef.current = Math.max(lastHandledBlockRef.current, Number(b));
      };
      readWs.on("block", onBlock);
      return () => { stop = true; readWs.off("block", onBlock); };
    }
    return () => { stop = true; };
  }, [read, readWs]);

  // ===== helper: read latest Draw logs to seed feed/lastDrawn on load
  async function fetchLatestDraws(ridN: number, take = 5) {
    if (!bingo || !read) return [];
    const fromBlock = Math.max(0, (latestBlock || 0) - LAST_LOG_LOOKBACK);
    const filter = (bingo as any).filters?.Draw?.(ridN);
    const logs = await (bingo as any).queryFilter(filter, fromBlock);
    const tail = logs.slice(-take).map((lg:any) => ({
      n: Number(lg.args?.number ?? lg.args?.[1]),
      tx: lg.transactionHash as string | undefined,
      ts: Date.now(),
    }));
    return tail;
  }

  // helper: round için son Payout log'unu bul (tx hash dahil)
  async function fetchLatestPayout(ridN: number) {
    if (!bingo || !read) return null;
    const fromBlock = Math.max(0, (latestBlock || 0) - LAST_LOG_LOOKBACK);
    const filter = (bingo as any).filters?.Payout?.(ridN);
    const logs = await (bingo as any).queryFilter(filter, fromBlock);
    const last = logs.slice(-1)[0];
    if (!last) return null;
    const [roundId, winner, winnerUSDC, feeUSDC] = last.args || [];
    return {
      roundId: Number(roundId),
      winner: String(winner),
      winnerUSDC: BigInt(winnerUSDC),
      feeUSDC: BigInt(feeUSDC),
      tx: last.transactionHash as string | undefined,
      ts: Date.now(),
    } as PayoutInfo;
  }

  // ===== shared pull (stable ref)
  const pullOnce = useCallback(async () => {
    if (!bingo || pulling.current) return;
    pulling.current = true;
    try {
      const rid: bigint = await bingo.currentRoundId();
      const ridN = Number(rid);

      setCurrentRoundId((prev) => {
        if (prev !== ridN) {
          setJoined(false);
          setHasCard(false);
          setCard([]);
          setCardRoundId(0);
          setLastDrawn(undefined);
          setDrawFeed([]);
        }
        return ridN;
      });

      if (ridN > 0) {
        const r = (await bingo.roundInfo(rid)) as unknown as RoundInfo;
        setRound(r);

        // round finalized ise ve winner var ise, payout event'ini yakala
        try {
          if (r.finalized && r.winner && r.winner !== "0x0000000000000000000000000000000000000000") {
            if (!lastPayout || lastPayout.roundId !== Number(rid)) {
              const p = await fetchLatestPayout(Number(rid));
              if (p) setLastPayout(p);
              else {
                setLastPayout({
                  roundId: Number(rid),
                  winner: r.winner,
                  winnerUSDC: r.prizePoolUSDC,
                  feeUSDC: 0n,
                  tx: undefined,
                  ts: Date.now(),
                });
              }
            }
          }
        } catch {}

        if (Number(r.drawCount) > 0 && lastDrawn === undefined) {
          try {
            const latest = await fetchLatestDraws(ridN, 5);
            if (latest.length) {
              setLastDrawn(latest[latest.length - 1].n);
              setDrawFeed(latest.reverse().slice(0,5));
            }
          } catch {}
        }
      } else {
        setRound(undefined);
      }

      if (usdc && account) {
        try {
          const [sym, dec, bal, allo] = await Promise.all([
            usdc.symbol(),
            usdc.decimals(),
            usdc.balanceOf(account),
            usdc.allowance(account, CONTRACT_ADDRESS),
          ]);
          setSymbol(sym);
          setDecimals(Number(dec));
          setBalance(bal);
          setAllowance(allo);
        } catch (e) { console.warn("ERC20 read error:", e); }
      }

      if (bingo && account && ridN > 0) {
        try {
          const players: string[] = await bingo.playersOf(rid);
          const isJoined = players.map((p) => p.toLowerCase()).includes(account.toLowerCase());
          setJoined(isJoined);

          const r2 = (await bingo.roundInfo(rid)) as unknown as RoundInfo;
          if (isJoined && r2.randomness !== 0n) {
            const raw: number[] = await bingo.cardOf(rid, account);
            const arr = Array.from(raw).map(Number);
            if (arr.length === 24) {
              setCard(arr);
              setHasCard(true);
              setCardRoundId(ridN);
            }
          }
        } catch (e) { console.warn("Game state read error:", e); }
      }
    } catch (e) {
      console.error("Polling error:", e);
    } finally {
      pulling.current = false;
    }
  }, [bingo, usdc, account, lastPayout, lastDrawn, latestBlock]);

  // ===== GAP-FILL: kopuklukta kaçan eventleri geriden tamamlama
  async function gapFill(fromHint?: number) {
    try {
      if (!bingo || !read) return;
      const latest = await read.getBlockNumber();
      const from = Math.max(0, (fromHint ?? lastHandledBlockRef.current) - 2); // küçük tampon
      if (from >= latest) return;

      const rid = Number(await bingo.currentRoundId()).valueOf();

      const fDraw   = (bingo as any).filters?.Draw?.(rid);
      const fPay    = (bingo as any).filters?.Payout?.(rid);
      const fVRF    = (bingo as any).filters?.VRFFulfilled?.(rid);
      const fCreate = (bingo as any).filters?.RoundCreated?.();

      const [logsD, logsP, logsV, logsC] = await Promise.all([
        fDraw   ? (bingo as any).queryFilter(fDraw,   from, latest) : [],
        fPay    ? (bingo as any).queryFilter(fPay,    from, latest) : [],
        fVRF    ? (bingo as any).queryFilter(fVRF,    from, latest) : [],
        fCreate ? (bingo as any).queryFilter(fCreate, from, latest) : [],
      ]);

      for (const lg of logsD) {
        const n  = Number(lg.args?.number ?? lg.args?.[1]);
        const tx = lg.transactionHash as string | undefined;
        setLastDrawn(n);
        setDrawFeed(prev => [{ n, tx, ts: Date.now() }, ...prev].slice(0,5));
      }

      const lastPay = logsP.slice(-1)[0];
      if (lastPay) {
        const [ridX, winner, winnerUSDC, feeUSDC] = lastPay.args || [];
        setLastPayout({
          roundId: Number(ridX),
          winner: String(winner),
          winnerUSDC: BigInt(winnerUSDC),
          feeUSDC: BigInt(feeUSDC),
          tx: lastPay.transactionHash as string | undefined,
          ts: Date.now(),
        });
      }

      if (logsV.length || logsC.length || logsD.length || logsP.length) {
        await pullOnce();
      }

      lastHandledBlockRef.current = latest;
      lastEventAtRef.current = Date.now();
    } catch (e) {
      console.warn("gapFill error:", e);
    }
  }

  // polling loop (HTTP ok; WSS olsa bile backup)
  useEffect(() => {
    let t: number;
    const loop = async () => {
      await pullOnce();
      t = window.setTimeout(loop, 1500);
    };
    loop();
    return () => window.clearTimeout(t);
  }, [pullOnce]);

  // ===== Wallet connect (universal) =====
  const connect = async () => {
    // Mini-app: yalnızca SDK provider
    const miniProv = await getMiniAppProvider();
    if (miniProv) {
      try {
        const accs = await miniProv.request({ method: "eth_requestAccounts" });
        setAccount(Array.isArray(accs) && accs.length ? accs[0] : "");
        const cid = await miniProv.request({ method: "eth_chainId" });
        if (cid) setChainId(Number(cid));
      } catch (e:any) {
        alert(e?.message ?? "Wallet connection failed");
      }
      return;
    }

    // Web
    const injected = await waitForInjectedEthereum(2000);
    if (injected?.request) {
      try {
        const accs = await injected.request({ method: "eth_requestAccounts" });
        setAccount(Array.isArray(accs) && accs.length ? accs[0] : "");
        const cid = await injected.request({ method: "eth_chainId" });
        if (cid) setChainId(Number(cid));
      } catch (e:any) {
        alert(e?.message ?? "Wallet connection failed");
      }
      return;
    }

    // Provider yok → yalnızca mobile’da deep-link
    if (isMobileUA()) {
      const dapp = location.href.replace(/^https?:\/\//, "");
      const metamask = `https://metamask.app.link/dapp/${dapp}`;
      const baseWallet = `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}`;
      try {
        window.open(metamask, "_self");
        setTimeout(() => window.open(baseWallet, "_self"), 1200);
      } catch {
        location.href = metamask;
      }
    } else {
      alert("No wallet detected. Please install MetaMask or use a mobile wallet browser.");
    }
  };

  // ===== Event subscriptions (WSS only) =====
  const onPayout = useCallback(async (_roundId: any, winner: string, winnerUSDC: bigint, feeUSDC: bigint, ev: any) => {
    try {
      lastEventAtRef.current = Date.now();
      if (ev?.log?.blockNumber != null) {
        lastHandledBlockRef.current = Math.max(lastHandledBlockRef.current, Number(ev.log.blockNumber));
      }
      const txHash: string | undefined = ev?.log?.transactionHash || ev?.transactionHash;
      setLastPayout({
        roundId: Number(_roundId),
        winner: String(winner),
        winnerUSDC: BigInt(winnerUSDC),
        feeUSDC: BigInt(feeUSDC),
        tx: txHash,
        ts: Date.now(),
      });
    } catch {}
    await pullOnce();
  }, [pullOnce]);

  useEffect(() => {
    if (!events) return;

    const onDraw = async (_roundId: any, number: number, _idx: number, ev: any) => {
      lastEventAtRef.current = Date.now();
      if (ev?.log?.blockNumber != null) {
        lastHandledBlockRef.current = Math.max(lastHandledBlockRef.current, Number(ev.log.blockNumber));
      }

      const n = Number(number);
      setLastDrawn(n);
      try {
        const txHash: string | undefined = ev?.log?.transactionHash || ev?.transactionHash;
        setDrawFeed((prev) => [{ n, tx: txHash, ts: Date.now() }, ...prev].slice(0,5));
      } catch {
        setDrawFeed((prev) => [{ n, ts: Date.now() }, ...prev].slice(0,5));
      }
      await pullOnce();
    };

    const onAny = async (...args:any[]) => {
      lastEventAtRef.current = Date.now();
      const maybeEv = args?.[args.length - 1];
      if (maybeEv?.log?.blockNumber != null) {
        lastHandledBlockRef.current = Math.max(lastHandledBlockRef.current, Number(maybeEv.log.blockNumber));
      }
      await pullOnce();
    };

    (events as any).on("Draw", onDraw);
    (events as any).on("VRFFulfilled", onAny);
    (events as any).on("RoundCreated", onAny);
    (events as any).on("Payout", onPayout);   // ← sadece bir payout handler

    return () => {
      (events as any).off("Draw", onDraw);
      (events as any).off("VRFFulfilled", onAny);
      (events as any).off("RoundCreated", onAny);
      (events as any).off("Payout", onPayout);
    };
  }, [events, onPayout, pullOnce]);

  // === WS liveness watchdog: 5s aralıkla kontrol et, 15s sessizlikte re-subscribe + gapFill
  useEffect(() => {
    let t = window.setInterval(async () => {
      if (!readWs || !events) { await pullOnce(); return; }

      const silenceMs = Date.now() - lastEventAtRef.current;
      if (silenceMs > 15000) {
        console.warn("WS stalled ~", silenceMs, "ms → resubscribe");

        // 1) eski WS’yi bırak
        try { (events as any).removeAllListeners?.(); } catch {}
        try { readWs.destroy?.(); } catch {}

        // 2) yeni WS provider’ı kur
        const fresh = new WebSocketProvider(RPC_WSS);
        // 3) contract’ı WS ile yeniden kur
        const newEvents = new Contract(CONTRACT_ADDRESS, BINGO_ABI, fresh);
        setEvents(newEvents as any);

        // 4) block listener yeniden
        fresh.on("block", (b: number) => {
          setLatestBlock(b);
          lastEventAtRef.current = Date.now();
          lastHandledBlockRef.current = Math.max(lastHandledBlockRef.current, Number(b));
        });

        // 5) kaçanları tamamla
        await gapFill();

        // 6) durum çek
        await pullOnce();
      }
    }, 5000);

    return () => window.clearInterval(t);
  }, [events, readWs, pullOnce]);

  // Tab görünür olunca anında toparla
  useEffect(() => {
    const onVis = async () => {
      if (!document.hidden) { await gapFill(); await pullOnce(); }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [pullOnce]);

  // signer helper
  const withSigner = async (c: Contract) => {
    if (!write) throw new Error("No wallet");
    const signer = await write.getSigner();
    return c.connect(signer);
  };

  const doApprove = async () => {
    if (!usdc) return;
    try {
      setLoadingTx("Approve...");
      const c = await withSigner(usdc);
      const tx = await (c as any).approve(CONTRACT_ADDRESS, parseUnits("10", decimals));
      await tx.wait();
      await pullOnce();
    } catch (e:any) {
      alert(e?.shortMessage ?? e?.message ?? "Approve failed");
    } finally { setLoadingTx(""); }
  };

  const doJoin = async () => {
    if (!bingo || !round || currentRoundId === 0) return;
    try {
      setLoadingTx("Join...");
      const c = await withSigner(bingo);
      const tx = await (c as any).joinRound(currentRoundId);
      await tx.wait();
      await pullOnce();
    } catch (e:any) {
      alert(e?.shortMessage ?? e?.message ?? "Join failed");
    } finally { setLoadingTx(""); }
  };

  const entryStr =
    round && decimals != null
      ? `${Number(formatUnits(round.entryFeeUSDC, decimals))} ${symbol}`
      : "-";
  const prizeStr =
    round && decimals != null
      ? `${Number(formatUnits(round.prizePoolUSDC, decimals)).toFixed(2)} ${symbol}`
      : "-";

  const statusText = useMemo(() => {
    if (!round) return "-";
    if (round.finalized) return "Round finished";
    if (round.randomness === 0n) {
      return nowSec < Number(round.joinDeadline) ? "Join window open" : "Waiting for VRF";
    }
    return `Drawing... (${round.drawCount}/${MAX_NUMBER})`;
  }, [round, nowSec]);

  // ---- Banner CTA logic (Connect/Approve/Join) ----
  const bannerCtaLabel = (() => {
    if (loadingTx) return loadingTx;
    if (!account) return "Connect Wallet";
    if (!round) return "Loading…";
    if (!canJoin) return "Join Closed";
    if (allowance < (round.entryFeeUSDC ?? 0n)) return `Approve ${symbol}`;
    return `Join • ${entryStr}`;
  })();

  const onBannerClick = async () => {
    if (loadingTx) return;
    if (!account) { await connect(); return; }
    if (!round || !canJoin) { alert("Join window is closed or not available yet."); return; }
    if (allowance < (round.entryFeeUSDC ?? 0n)) { await doApprove(); return; }
    await doJoin();
  };
  // -----------------------------------------------

  // ===== GLOBAL mouse-reactive BACKGROUND (whole page) =====
  const pgRaf = useRef<number | null>(null);
  const pgTarget = useRef({ x: 0, y: 0 });
  const pgCurrent = useRef({ x: 0, y: 0 });

  const setPageVars = (x:number, y:number) => {
    const root = document.documentElement;
    root.style.setProperty("--pmx", String(x)); // -1..1
    root.style.setProperty("--pmy", String(y));
  };

  useEffect(() => {
    const lerp = () => {
      pgCurrent.current.x += (pgTarget.current.x - pgCurrent.current.x) * 0.1;
      pgCurrent.current.y += (pgTarget.current.y - pgCurrent.current.y) * 0.1;
      setPageVars(pgCurrent.current.x, pgCurrent.current.y);
      pgRaf.current = requestAnimationFrame(lerp);
    };
    const onMove = (e: MouseEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;   // -1..1
      const ny = (e.clientY / window.innerHeight) * 2 - 1;  // -1..1
      pgTarget.current.x = Math.max(-1, Math.min(1, nx));
      pgTarget.current.y = Math.max(-1, Math.min(1, ny));
      if (pgRaf.current == null) pgRaf.current = requestAnimationFrame(lerp);
    };
    const onLeave = () => {
      pgTarget.current.x = 0; pgTarget.current.y = 0;
      if (pgRaf.current == null) pgRaf.current = requestAnimationFrame(lerp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    pgRaf.current = requestAnimationFrame(lerp);

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
      if (pgRaf.current) cancelAnimationFrame(pgRaf.current);
      pgRaf.current = null;
    };
  }, []);

  // Set tab title + favicon
  useEffect(() => {
    try {
      document.title = "BingoBase.io";
      const setIcon = (href: string, rel: string) => {
        let link = document.querySelector(`link[rel='${rel}']`) as HTMLLinkElement | null;
        if (!link) { link = document.createElement('link'); link.rel = rel; document.head.appendChild(link); }
        link.href = href;
      };
      setIcon('/BingoBase4.png', 'icon');
      setIcon('/BingoBase4.png', 'shortcut icon');
      setIcon('/BingoBase4.png', 'apple-touch-icon');
    } catch {}
  }, []);

  return (
    <div style={styles.wrap}>
      <style>{`
        :root { color-scheme: dark; --pmx:0; --pmy:0; }
        html, body, #root { background: ${THEME_BG}; }

        /* === FULL-PAGE reactive layers (behind everything) === */
        .bb-global-bg{
          position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow:hidden;
          background:
            radial-gradient(1600px 800px at calc(80% + var(--pmx)*10%) calc(-5% + var(--pmy)*4%),
              rgba(27,94,255,.12), transparent 60%),
            radial-gradient(1200px 700px at calc(15% + var(--pmx)*-8%) calc(110% + var(--pmy)*10%),
              rgba(0,200,83,.09), transparent 60%),
            linear-gradient(180deg, #0b0f14 0%, #0a0e15 50%, #0a0f17 100%);
        }
        .bb-global-scan{
          position:absolute; inset:-20%;
          background: repeating-linear-gradient(115deg, rgba(150,190,255,.05) 0 6px, transparent 6px 18px);
          transform:
            translate3d(calc(var(--pmx)*24px), calc(var(--pmy)*28px), 0)
            skewY(-6deg);
          animation: bg-scan 24s linear infinite;
          mix-blend:overlay;
          mask-image: radial-gradient(65% 60% at 50% 40%, black 55%, transparent 75%);
          opacity:.8; will-change: transform;
        }
        .bb-global-scan.alt{
          animation-duration: 36s; opacity:.45;
          transform:
            translate3d(calc(var(--pmx)*-18px), calc(var(--pmy)*-22px), 0)
            skewY(-8deg);
        }
        @keyframes bg-scan{
          to{
            transform:
              translate3d(calc(var(--pmx)*24px), calc(var(--pmy)*28px), 0)
              skewY(-6deg) translateY(-12%);
          }
        }
        .bb-orb-a, .bb-orb-b, .bb-orb-c{
          position:absolute; border-radius:50%;
          filter: blur(22px); mix-blend:screen; pointer-events:none; opacity:.22; will-change: transform;
        }
        .bb-orb-a{
          width:520px; height:520px; right:-120px; top:-100px;
          background: radial-gradient(closest-side, rgba(27,94,255,.55), transparent);
          transform: translate3d(calc(var(--pmx)*42px), calc(var(--pmy)*34px), 0);
        }
        .bb-orb-b{
          width:420px; height:420px; left:-120px; bottom:-120px;
          background: radial-gradient(closest-side, rgba(0,200,83,.48), transparent);
          transform: translate3d(calc(var(--pmx)*-36px), calc(var(--pmy)*-30px), 0);
        }
        .bb-orb-c{
          width:380px; height:380px; left:35%; top:-140px;
          background: radial-gradient(closest-side, rgba(0,180,255,.35), transparent);
          transform: translate3d(calc(var(--pmx)*18px), calc(var(--pmy)*12px), 0);
          opacity:.18;
        }

        @media (max-width: 768px){
          .bb-global-scan, .bb-global-scan.alt { transform: none; }
          .bb-orb-a, .bb-orb-b, .bb-orb-c { transform: none; }
        }
        /* === /FULL-PAGE BG === */

        @media (max-width: 1200px) { .cols { grid-template-columns: 1fr; } }
        .hover-grow { transition: transform .14s ease, box-shadow .14s ease; }
        .hover-grow:hover { transform: scale(2); box-shadow: 0 6px 20px rgba(0,0,0,.35); }
        .no-select { user-select: none; }
        a{ color:#9ecbff }
      `}</style>

      {/* GLOBAL BACKGROUND LAYERS */}
      <div className="bb-global-bg" aria-hidden="true">
        <div className="bb-global-scan" />
        <div className="bb-global-scan alt" />
        <div className="bb-orb-a" />
        <div className="bb-orb-b" />
        <div className="bb-orb-c" />
      </div>

      <Header />

      {/* ===== PROMO BANNER ===== */}
      <section className="bb-banner" role="region" aria-label="BingoBase promo" style={{margin:"18px 0", position:"relative", zIndex:1}}>
        <style>{`
          .bb-banner{
            --bg1:#0a0f17;--bg2:#0c1220;--c1:#e7eef7;--c2:#8ea0b3;--acc:#1b5eff;--chip:#0e1620;--glow:#4da3ff;
            position:relative;overflow:hidden;border-radius:18px;border:1px solid #1e2a38;padding:28px;
            background: radial-gradient(1200px 600px at 80% -10%, rgba(27,94,255,.18), transparent 60%),
                        radial-gradient(900px 500px at 10% 120%, rgba(0,200,83,.14), transparent 60%),
                        linear-gradient(180deg,var(--bg1),var(--bg2));
            box-shadow: 0 12px 40px rgba(0,0,0,.35);
            isolation:isolate;
          }
          .bb-banner__inner{max-width:1100px;margin:0 auto;display:grid;gap:18px;grid-template-columns:120px 1fr;align-items:center}
          .bb-banner__logo-wrap{display:flex;align-items:center;justify-content:center; margin-left:-24px;}
          .bb-banner__inner{ min-height:220px; }
          .bb-banner__logo{ height:320px; }
          .bb-banner__logo{
            width:240px;
            height:auto;
            filter:drop-shadow(0 10px 30px rgba(0,0,0,.45));
            animation: bb-pop .6s ease-out both, bb-breathe 2.25s ease-in-out infinite;
          }
          @keyframes bb-pop{from{transform:scale(.8);opacity:0} to{transform:scale(1);opacity:1}}
          @keyframes bb-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}

          .bb-banner__body{display:grid;gap:14px}
          .bb-badge{
            display:inline-flex;gap:8px;align-items:center;background:var(--chip);border:1px solid #1e2a38;
            padding:6px 10px;border-radius:999px;color:var(--c1);font:600 12px/1.1 system-ui,Segoe UI,Inter,Arial;
            text-transform:uppercase;letter-spacing:.08em;
            box-shadow: inset 0 0 0 1px rgba(255,255,255,.02);
          }
          .bb-badge .dot{width:6px;height:6px;border-radius:50%;background:var(--acc);box-shadow:0 0 10px var(--glow)}
          .bb-title{margin:0;color:var(--c1);font:800 28px/1.15 Inter,system-ui,Segoe UI,Arial;letter-spacing:.2px}
          .bb-sub{margin:0;color:var(--c2);font:500 14px/1.5 Inter,system-ui}
          .bb-points{display:flex;flex-wrap:wrap;gap:10px}
          .bb-chip{
            color:var(--c1);background:rgba(255,255,255,.04);border:1px solid #223146;border-radius:10px;padding:8px 10px;
            font:700 13px/1.1 Inter,system-ui
          }
          .bb-cta{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
          .bb-btn{
            appearance:none;border:none;border-radius:12px;padding:12px 18px;background:var(--acc);color:white;
            font:800 14px/1 Inter,system-ui;cursor:pointer;transition:transform .12s ease, box-shadow .12s ease, opacity .2s ease;
            box-shadow:0 10px 30px rgba(27,94,255,.35)
          }
          .bb-btn:hover{transform:translateY(-1px);box-shadow:0 16px 36px rgba(27,94,255,.45)}
          .bb-link{color:#9ecbff;text-decoration:none;font:700 13px/1 Inter,system-ui}
          .bb-counters{display:flex;gap:14px;flex-wrap:wrap}
          .bb-kpi{
            min-width:140px;background:rgba(255,255,255,.03);border:1px solid #223146;border-radius:14px;padding:12px 14px;
            display:grid;gap:6px
          }
          .bb-kpi .v{color:var(--c1);font:800 18px/1 Inter}
          .bb-kpi .l{color:var(--c2);font:600 12px/1.1 Inter;text-transform:uppercase;letter-spacing:.06em}

          .bb-lines::before,.bb-lines::after{
            content:"";position:absolute;inset:-20%;background:
              repeating-linear-gradient(115deg, rgba(150,190,255,.05) 0 6px, transparent 6px 18px);
            transform:skewY(-6deg);animation:bb-scan 18s linear infinite;pointer-events:none;mix-blend:overlay;mask-image:radial-gradient(55% 60% at 50% 40%, black 55%, transparent 70%);
          }
          .bb-lines::after{animation-duration:26s;opacity:.5}
          @keyframes bb-scan{to{transform:skewY(-6deg) translateY(-10%)}}

          @media (max-width:900px){
            .bb-banner__inner{grid-template-columns:90px 1fr}
            .bb-banner{padding:22px}
            .bb-title{font-size:24px}
            .bb-sub{font-size:13px}
          }
          @media (max-width:620px){
            .bb-banner__inner{grid-template-columns:1fr; text-align:center}
            .bb-banner__logo{width:92px;margin:0 auto}
            .bb-cta{justify-content:center}
            .bb-counters{justify-content:center}
          }
        `}</style>

        <div className="bb-lines" aria-hidden="true"></div>

        <div className="bb-banner__inner">
          <div className="bb-banner__logo-wrap">
            <img className="bb-banner__logo" src="/BingoBase4.png" alt="BingoBase logo" />
          </div>

          <div className="bb-banner__body">
            <span className="bb-badge"><span className="dot" aria-hidden="true"></span> Built for Base Batches 002 — Builder Track</span>

            <h2 className="bb-title">BingoBase.io — Fair, Transparent, On-chain Bingo</h2>

            <p className="bb-sub">
              An on-chain, provably random Bingo powered by Chainlink VRF v2.5. <br />
              <strong>Each game means at least 100 transactions on Base.</strong> <br />
              contact: fractaliaio@gmail.com
            </p>

            <div className="bb-points">
              <span className="bb-chip">💠 Provable VRF randomness</span>
              <span className="bb-chip">💵 Entry: 1 USDC</span>
              <span className="bb-chip">🏆 Winner takes the entire pool</span>
              <span className="bb-chip">♻️ Keeps drawing until someone wins</span>
            </div>

            <div className="bb-cta">
              <button className="bb-btn" onClick={onBannerClick} disabled={loadingTx !== ""}>
                {bannerCtaLabel}
              </button>
              <a className="bb-link" href="https://basescan.org" target="_blank" rel="noopener">See it on Base →</a>
            </div>

            <div className="bb-counters" aria-label="Banner stats">
              <div className="bb-kpi">
                <div className="v">100+ tx</div><div className="l">per game on Base</div>
              </div>
              <div className="bb-kpi">
                <div className="v">VRF</div><div className="l">provable randomness</div>
              </div>
              <div className="bb-kpi">
                <div className="v">1 USDC</div><div className="l">entry fee</div>
              </div>
            </div>
          </div>
        </div>
      </section>
      {/* ===== /PROMO BANNER ===== */}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -6, marginBottom: 12, position:"relative", zIndex:1 }}>
        {account ? (
          <code
            className="no-select"
            style={{
              fontSize: 12,
              background: CHIP_BG,
              padding: "6px 10px",
              borderRadius: 8,
              color: THEME_TEXT,
              border: `1px solid ${CARD_BORDER}`
            }}
          >
            {account.slice(0, 6)}…{account.slice(-4)}
          </code>
        ) : (
          <button style={btnPrimary(true)} onClick={connect}>Connect Wallet</button>
        )}
      </div>

      <TopBar chainId={chainId} account={account} onConnect={connect} />

      {/* WINNER / PAYOUT DUYURUSU */}
      {lastPayout && (
        <div
          role="status"
          style={{
            position: "relative",
            zIndex: 2,
            margin: "8px 0 12px",
            padding: "12px 14px",
            borderRadius: 12,
            background: "linear-gradient(180deg, rgba(0,200,83,.12), rgba(0,0,0,.06))",
            border: `1px solid ${CARD_BORDER}`,
            color: THEME_TEXT,
            boxShadow: "0 8px 24px rgba(0,0,0,.25)"
          }}
        >
          <div style={{display:"flex", alignItems:"center", gap:10, flexWrap:"wrap"}}>
            <span style={{
              width:10, height:10, borderRadius:6, background: ACTIVE_GREEN,
              display:"inline-block", boxShadow:"0 0 12px rgba(0,200,83,.6)"
            }} />
            <strong style={{fontWeight:800}}>Winner announced!</strong>
            <span style={{opacity:.9}}>
              Round <b>#{lastPayout.roundId}</b> —{" "}
              <a
                href={`${EXPLORER}/address/${lastPayout.winner}`}
                target="_blank" rel="noreferrer"
                style={{color:"#9ecbff", fontWeight:700}}
              >
                {lastPayout.winner.slice(0,6)}…{lastPayout.winner.slice(-4)}
              </a>{" "}
              received{" "}
              <b>{Number(formatUnits(lastPayout.winnerUSDC, decimals)).toFixed(2)} {symbol}</b>.
            </span>
            {lastPayout.tx ? (
              <a
                href={`${EXPLORER}/tx/${lastPayout.tx}`}
                target="_blank" rel="noreferrer"
                style={{marginLeft:8, color:"#9ecbff", fontWeight:700}}
              >
                View payout tx →
              </a>
            ) : (
              <span style={{marginLeft:8, color:THEME_MUTED}}>(tx pending)</span>
            )}
          </div>
        </div>
      )}

      {diag.msg && (
        <div style={{background:"#2a1515", border:`1px solid ${CARD_BORDER}`, padding:12, borderRadius:10, marginBottom:12, color:THEME_TEXT}}>
          <b>Config issue:</b> {diag.msg}<br/>
          <small>chainId seen: {diag.chainId ?? "?"} • address: {CONTRACT_ADDRESS}</small>
        </div>
      )}

      {!RPC_URL && (
        <div style={{background:"#211a0c", border:`1px solid ${CARD_BORDER}`, padding:12, borderRadius:10, marginBottom:12}}>
          <b>RPC_URL missing.</b> Set VITE_RPC_URL in Vercel and redeploy.
        </div>
      )}
      {!RPC_WSS && (
        <div style={{background:"#0f1726", border:`1px solid ${CARD_BORDER}`, padding:12, borderRadius:10, marginBottom:12}}>
          <b>VITE_RPC_WSS not set.</b> Live events will rely on HTTP polling only.
        </div>
      )}

      <section className="cols" style={styles.columns}>
        {/* Left */}
        <div style={styles.leftCol}>
          <Card title="Main Hall">
            <Row label="Current Round">{currentRoundId || "-"}</Row>
            <Row label="Entry Fee">{entryStr}</Row>
            <Row label="Prize Pool">{prizeStr}</Row>
            <Row label="Start">
              {round ? new Date(Number(round.startTime) * 1000).toLocaleString() : "-"}
            </Row>
            <Row label="Join Window">
              {round ? (nowSec < Number(round.joinDeadline) ? `${Math.max(0, Number(round.joinDeadline) - nowSec)}s left` : "Closed") : "-"}
            </Row>
            <Row label="Status">{statusText}</Row>

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button
                style={btnPrimary(!!account && canJoin && allowance >= (round?.entryFeeUSDC ?? 0n) && loadingTx === "")}
                disabled={!account || !canJoin || loadingTx !== "" || !round || allowance < (round?.entryFeeUSDC ?? 0n)}
                onClick={doJoin}
                title={
                  !account ? "Connect your wallet"
                  : !canJoin ? "Join window closed or already joined"
                  : allowance < (round?.entryFeeUSDC ?? 0n) ? "Approve USDC first" : ""
                }
              >
                {loadingTx === "Join..." ? "Joining..." : `Join • ${entryStr}`}
              </button>

              <button style={btnGhost} disabled={!account || loadingTx !== "" || !round} onClick={doApprove}>
                {loadingTx === "Approve..." ? "Approving..." : `Approve ${symbol}`}
              </button>
            </div>

            <div style={{ marginTop: 8, fontSize: 12, color: THEME_MUTED }}>
              Wallet balance: <span style={{color:THEME_TEXT}}>{Number(formatUnits(balance, decimals)).toFixed(2)} {symbol}</span> ·{" "}
              Allowance: <span style={{color:THEME_TEXT}}>{Number(formatUnits(allowance, decimals)).toFixed(2)} {symbol}</span>
            </div>
          </Card>

          <Card title="All Draws (so far)">
            {allDrawnList.length === 0 ? (
              <div style={{ color: THEME_MUTED }}>No draws yet.</div>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {allDrawnList.map((n) => <Ball key={n} n={n} active={n === lastDrawn} />)}
              </div>
            )}
          </Card>
        </div>

        {/* Middle */}
        <div style={styles.midCol}>
          <Card title="Live Board (1–90)">
            <Grid90 drawn={drawnSet} last={lastDrawn} />
          </Card>

          {hasCard && card.length === 24 && cardRoundId === currentRoundId && (
            <Card title="Your Card (24)">
              <div style={{ minHeight: CARD_MIN_H }}>
                <GridCard card={card} drawn={drawnSet} last={lastDrawn} />
              </div>
            </Card>
          )}
        </div>

        {/* Right: Chat + Last 5 draws */}
        <div style={styles.chatCol}>
          <ChatPanel account={account} />
          <div style={{ height: 12 }} />
          <Card title="Last 5 Draws">
            {drawFeed.length === 0 ? (
              <div style={{ color: THEME_MUTED }}>Waiting for draws…</div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {drawFeed.map((d, i) => (
                  <div key={i} style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                    <div style={{fontWeight:800, color:THEME_TEXT}}>#{d.n}</div>
                    {d.tx ? (
                      <a href={`${EXPLORER}/tx/${d.tx}`} target="_blank" rel="noreferrer">View tx</a>
                    ) : (
                      <span style={{color:THEME_MUTED}}>tx pending</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </section>

      <footer
        style={{
          position: "relative",
          zIndex: 2,
          margin: "32px 0",
          paddingBottom: 24,
          textAlign: "center",
          fontSize: 12,
          color: THEME_MUTED,
        }}
      >
        Contract:{" "}
        <a href={`${EXPLORER}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer">
          {CONTRACT_ADDRESS}
        </a>{" "}
        · USDC:{" "}
        <a href={`${EXPLORER}/address/${USDC_ADDRESS}`} target="_blank" rel="noreferrer">
          {USDC_ADDRESS}
        </a>
      </footer>
    </div>
  );
}

// ===== UI parts =====
function Header() {
  return (
    <div style={{ padding: "8px 0 0" }}>
      <div style={{display:"flex", justifyContent:"center"}}>
        {/* optional logo */}
      </div>
    </div>
  );
}

function TopBar({ account, onConnect, chainId }:{ account?: string; onConnect: () => void; chainId?: number; }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <div style={{ fontWeight: 700, color: THEME_TEXT }}>Main Hall</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: THEME_MUTED }}>ChainId: {chainId ?? "-"}</span>
        {account ? (
          <code className="no-select" style={{ fontSize: 12, background: CHIP_BG, padding: "6px 10px", borderRadius: 8, color: THEME_TEXT, border: `1px solid ${CARD_BORDER}` }}>
            {account.slice(0, 6)}…{account.slice(-4)}
          </code>
        ) : (
          <button style={btnPrimary(true)} onClick={onConnect}>Connect Wallet</button>
        )}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: any }) {
  return (
    <div style={styles.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18, color: THEME_TEXT }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: any }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${CARD_BORDER}`, color: THEME_TEXT }}>
      <div style={{ color: THEME_MUTED }}>{label}</div>
      <div style={{ fontWeight: 700 }}>{children}</div>
    </div>
  );
}

function Grid90({ drawn, last }: { drawn: Set<number>; last?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 6 }}>
      {Array.from({ length: MAX_NUMBER }, (_, i) => i + 1).map((n) => {
        const isDrawn = drawn.has(n);
        const isLast = last === n;
        return (
          <div
            key={n}
            className="hover-grow no-select"
            style={{
              border: `1px solid ${CARD_BORDER}`,
              borderRadius: 8,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: isDrawn ? (isLast ? ACTIVE_GREEN : DRAWN_BLUE) : CARD_BG,
              color: isDrawn ? (isLast ? ACTIVE_GREEN_TEXT : DRAWN_BLUE_TEXT) : THEME_TEXT,
              fontWeight: 700,
            }}
            title={String(n)}
          >{n}</div>
        );
      })}
    </div>
  );
}

function GridCard({ card, drawn, last }: { card: number[]; drawn: Set<number>; last?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: CARD_GAP }}>
      {card.map((n, idx) => {
        const isDrawn = drawn.has(n);
        const isLast = last === n;
        return (
          <div
            key={idx}
            className="hover-grow no-select"
            style={{
              border: `1px solid ${CARD_BORDER}`,
              borderRadius: 10,
              height: CARD_CELL_H,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: isDrawn ? (isLast ? ACTIVE_GREEN : DRAWN_BLUE) : CARD_BG,
              color: isDrawn ? (isLast ? ACTIVE_GREEN_TEXT : DRAWN_BLUE_TEXT) : THEME_TEXT,
              fontWeight: 800,
              fontSize: 16,
            }}
            title={String(n)}
          >{n}</div>
        );
      })}
    </div>
  );
}

function Ball({ n, active = false }: { n: number; active?: boolean }) {
  const isLast = active;
  const bg = isLast ? ACTIVE_GREEN : DRAWN_BLUE;
  const fg = isLast ? ACTIVE_GREEN_TEXT : DRAWN_BLUE_TEXT;
  return (
    <div className="hover-grow no-select" style={{ width: 34, height: 34, borderRadius: 17, display: "flex", alignItems: "center", justifyContent: "center", background: bg, color: fg, border: `1px solid ${CARD_BORDER}`, fontWeight: 800 }} title={String(n)}>
      {n}
    </div>
  );
}


// ===== Chat Panel (GLOBAL) =====
function ChatPanel({ account }:{ account?: string }) {
  // nick formatını sabitle: cüzdan varsa :abcd, yoksa :anon
  const nick = (account ? account.toLowerCase() : ':anon');

  type Msg = { id: string; from: string; text: string; ts: number; clientId?: string };

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"disconnected"|"connecting"|"connected">("disconnected");

  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const retryRef = useRef<number>(0);
  const lastSendRef = useRef<number>(0);

  // ---- cache + autoscroll
  useEffect(() => {
    if (msgs.length) {
      try { localStorage.setItem("bb_chat_cache", JSON.stringify(msgs.slice(-300))); } catch {}
    }
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs]);

  // ---- connect once
  useEffect(() => {
    let stop = false;
    if (!CHAT_WSS) return;

    const connectWs = () => {
      if (stop) return;
      try {
        setStatus("connecting");
        const ws = new WebSocket(CHAT_WSS);
        wsRef.current = ws;

        ws.onopen = () => {
          setStatus("connected");
          retryRef.current = 0;
          // ilk join (anon olabilir)
          try { ws.send(JSON.stringify({ type: "join", from: nick })); } catch {}
        };

        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);

            if (data?.type === "history" && Array.isArray(data.items)) {
              const incoming: Msg[] = data.items.map((d:any) => ({
                id: String(d.id || crypto.randomUUID()),
                from: String(d.from || ":anon"),
                text: String(d.text || "").slice(0, 280),
                ts: Number(d.ts) || Date.now(),
                clientId: d.clientId ? String(d.clientId) : undefined,
              }));

              setMsgs(prev => {
                const uniq = new Map<string, Msg>();
                for (const m of prev) uniq.set(m.id, m);
                for (const m of incoming) uniq.set(m.id, m);
                return Array.from(uniq.values()).sort((a,b)=>a.ts-b.ts).slice(-300);
              });
              return;
            }

            if (data?.type === "msg" && typeof data.text === "string") {
              const incoming: Msg = {
                id: String(data.id || crypto.randomUUID()),
                from: String(data.from || ":anon"),
                text: String(data.text).slice(0, 280),
                ts: Number(data.ts) || Date.now(),
                clientId: data.clientId ? String(data.clientId) : undefined,
              };

              setMsgs(prev => {
                // 1) optimistic replace: clientId eşleşirse yer değiştirme
                if (incoming.clientId) {
                  const idx = prev.findIndex(x => x.clientId === incoming.clientId);
                  if (idx !== -1) {
                    const copy = prev.slice();
                    copy[idx] = incoming;
                    return copy;
                  }
                }

                // 2) id dupe koruması
                if (prev.some(x => x.id === incoming.id)) return prev;

                // 3) heüristik: aynı kullanıcı + aynı metin + 1500ms içinde
                let nearDup = false;
                for (let i = prev.length - 1; i >= 0 && i >= prev.length - 10; i--) {
                  const x = prev[i];
                  if (x.from === incoming.from && x.text === incoming.text && Math.abs(incoming.ts - x.ts) < 1500) {
                    nearDup = true; break;
                  }
                }
                if (nearDup) return prev;

                return [...prev, incoming];
              });
              return;
            }
          } catch {}
        };

        ws.onclose = () => {
          setStatus("disconnected");
          wsRef.current = null;
          const delay = Math.min(15000, 1000 * (2 ** retryRef.current));
          retryRef.current += 1;
          setTimeout(connectWs, delay);
        };

        ws.onerror = () => {
          try { ws.close(); } catch {}
        };
      } catch {
        setStatus("disconnected");
        setTimeout(connectWs, 2000);
      }
    };

    connectWs();
    return () => { stop = true; try { wsRef.current?.close(); } catch {} };
    // sadece bir kez
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- account değişince nick’i güncelle
  useEffect(() => {
    try { wsRef.current?.send(JSON.stringify({ type: "join", from: nick })); } catch {}
  }, [nick]);

  // ---- send
  const send = () => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return;

    const now = Date.now();
    if (now - lastSendRef.current < 400) return; // küçük rate limit
    lastSendRef.current = now;

    // optimistic
    const clientId = crypto.randomUUID();
    const safe = trimmed.slice(0, 280);
    const optimistic: Msg = { id: `local-${clientId}`, from: nick, text: safe, ts: now, clientId };
    setMsgs(x => [...x, optimistic]);
    setText("");

    if (wsRef.current && wsRef.current.readyState === 1) {
      wsRef.current.send(JSON.stringify({
        type: "msg",
        from: nick,
        text: safe,
        ts: now,
        clientId,   // server bunu geri yollar → optimistic replace
      }));
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") send(); };

  const dot =
    status === "connected" ? "#00C853" :
    status === "connecting" ? "#f6ad55" : "#ef4444";

  return (
    <div style={styles.card}>
      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12}}>
        <h3 style={{ margin: 0, fontSize: 18, color: THEME_TEXT }}>Global Chat</h3>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ width:10, height:10, borderRadius:5, background: dot, display:"inline-block" }} />
          <div style={{ fontSize:12, color: THEME_MUTED }}>You: {nick}</div>
        </div>
      </div>

      <div ref={listRef} style={{height: 420, overflowY: "auto", display:"flex", flexDirection:"column", gap:8, paddingRight:4}}>
        {msgs.length === 0 && <div style={{ color: THEME_MUTED }}>No messages yet. Be the first!</div>}
        {msgs.map(m => (
          <div key={m.id} style={{ display:"flex", gap:8, alignItems:"flex-start"}}>
            <div style={{width:28, height:28, borderRadius:14, background: CHIP_BG, border:`1px solid ${CARD_BORDER}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color: THEME_TEXT}}>
              {m.from.slice(-2)}
            </div>
            <div>
              <div style={{fontSize:12, color: THEME_MUTED}}>
                {m.from} • {new Date(m.ts).toLocaleTimeString()}
              </div>
              <div style={{fontWeight:600, color: THEME_TEXT, wordBreak:"break-word"}}>
                {m.text}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{display:"flex", gap:8, marginTop:12}}>
        <input
          placeholder={status === "connected" ? "Type a message..." : "Connecting…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={status !== "connected"}
          maxLength={280}
          style={{flex:1, background: "#0f141b", color: THEME_TEXT, border:`1px solid ${CARD_BORDER}`, borderRadius:10, padding:"10px 12px"}}
        />
        <button style={btnPrimary(status === "connected")} disabled={status !== "connected"} onClick={send}>Send</button>
      </div>
    </div>
  );
}

// ===== Styles =====
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    maxWidth: 1480,
    margin: "24px auto",
    padding: "0 24px",
    fontFamily: "Inter, system-ui, Arial",
    background: "transparent",
    color: THEME_TEXT,
    position: "relative",
    zIndex: 1,
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "minmax(320px,1.05fr) minmax(420px,1.05fr) minmax(360px,0.9fr)",
    gap: 24,
    alignItems: "start",
  },
  leftCol: {},
  midCol: {},
  chatCol: {},
  card: {
    padding: 18,
    border: `1px solid ${CARD_BORDER}`,
    borderRadius: 16,
    background: CARD_BG,
    boxShadow: CARD_SHADOW,
    marginBottom: 18,
    backdropFilter: "saturate(120%)",
  },
};

function btnPrimary(enabled: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid transparent",
    cursor: enabled ? "pointer" : "not-allowed",
    background: enabled ? BTN_PRIMARY_BG : BTN_PRIMARY_BG_DISABLED,
    color: THEME_TEXT,
    fontWeight: 800,
  };
}
const btnGhost: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: `1px solid ${CARD_BORDER}`,
  cursor: "pointer",
  background: CARD_BG,
  color: THEME_TEXT,
  fontWeight: 700,
};
