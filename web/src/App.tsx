import { useEffect, useMemo, useRef, useState } from "react";
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

const BASE_BLUE   = "#0052FF";
const MAX_NUMBER  = 90;
const CARD_SIZE   = 24;

// ===== Minimal ABIs =====
const BINGO_ABI = [
  // views
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

  // writes visible to user
  "function joinRound(uint256 roundId) external",

  // admin/bot (not called from UI, but ABI needed for events)
  "function requestRandomness(uint256 roundId) external",
  "function drawNext(uint256 roundId) external",
  "function claimBingo(uint256 roundId) external",

  // events
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

function useProviders() {
  // Prefer WSS for reads (live) and events; fallback to HTTPS for reads if WSS missing
  const readWs = useMemo(
    () => (RPC_WSS ? new WebSocketProvider(RPC_WSS) : undefined),
    []
  );
  const readHttp = useMemo(
    () => (RPC_URL ? new JsonRpcProvider(RPC_URL) : undefined),
    []
  );

  // Wallet provider (injected)
  const [write, setWrite] = useState<BrowserProvider>();
  useEffect(() => {
    if ((window as any).ethereum) {
      try {
        setWrite(new BrowserProvider((window as any).ethereum));
      } catch (e) {
        console.warn("BrowserProvider init failed:", e);
      }
    }
  }, []);

  return { readWs, readHttp, write };
}

export default function App() {
  const { readWs, readHttp, write } = useProviders();

  // wallet
  const [account, setAccount] = useState<string>("");
  const [chainId, setChainId] = useState<number>();

  // providers chosen
  const [readProviderName, setReadProviderName] = useState<string>("(unused)");
  const read = readWs ?? readHttp; // prefer WSS
  useEffect(() => {
    setReadProviderName(readWs ? "WSS" : (readHttp ? "HTTP" : "(none)"));
    if (!readWs && !readHttp) {
      console.error("No RPC providers are configured. Set VITE_RPC_WSS and/or VITE_RPC_URL.");
    }
  }, [readWs, readHttp]);

  // contracts
  const [bingo, setBingo]   = useState<Contract>();
  const [events, setEvents] = useState<Contract>(); // events bound to WSS if available
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
  const [loadingTx, setLoadingTx]           = useState<string>("");

  // diagnostics
  const [latestBlock, setLatestBlock] = useState<number>(0);
  const [diag, setDiag] = useState<{ hasCode?: boolean; chainId?: number; msg?: string }>({});

  const pulling = useRef(false);
  const nowSec  = Math.floor(Date.now() / 1000);

  // === diagnose block: confirm RPC + bytecode at address ===
  useEffect(() => {
    (async () => {
      try {
        if (!RPC_URL || !CONTRACT_ADDRESS) return;
        const p = new JsonRpcProvider(RPC_URL);
        const [net, code] = await Promise.all([p.getNetwork(), p.getCode(CONTRACT_ADDRESS)]);
        const hasCode = !!code && code !== "0x";
        setDiag({
          hasCode,
          chainId: Number(net.chainId),
          msg: hasCode ? undefined : "No bytecode at VITE_CONTRACT_ADDRESS on this RPC",
        });
        console.log("[diagnose] chainId =", Number(net.chainId), "hasCode =", hasCode);
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

  const lastDrawnList = useMemo(
    () => Array.from(drawnSet).sort((a, b) => a - b).slice(-10),
    [drawnSet]
  );

  // init contracts
  useEffect(() => {
    if (read && CONTRACT_ADDRESS) {
      setBingo(new Contract(CONTRACT_ADDRESS, BINGO_ABI, read));
      console.log(`[frontend] bingo read via ${readProviderName}`);
    }
    // Events should prefer WSS; if not present, we still fall back to HTTP polling
    if (readWs && CONTRACT_ADDRESS) {
      setEvents(new Contract(CONTRACT_ADDRESS, BINGO_ABI, readWs));
      console.log("[frontend] event subscription bound to WSS");
    } else {
      setEvents(undefined);
      console.log("[frontend] no WSS; events disabled (HTTP polling only)");
    }
    if (read && USDC_ADDRESS) {
      setUsdc(new Contract(USDC_ADDRESS, ERC20_ABI, read));
    }
  }, [read, readWs, readProviderName]);

  // track latest block for “live” indicator
  useEffect(() => {
    if (!read) return;
    let stop = false;

    const tick = async () => {
      try {
        const bn = await read.getBlockNumber();
        if (!stop) setLatestBlock(bn);
      } catch {}
      if (!stop) setTimeout(tick, readWs ? 1000 : 3000);
    };
    tick();

    // if WSS: also listen on 'block' (faster)
    if (readWs) {
      const onBlock = (b: number) => setLatestBlock(b);
      readWs.on("block", onBlock);
      return () => {
        stop = true;
        readWs.off("block", onBlock);
      };
    }
    return () => { stop = true; };
  }, [read, readWs]);

  // wallet connect
  const connect = async () => {
    if (!write) return alert("No wallet found.");
    const accs = await write.send("eth_requestAccounts", []);
    setAccount(accs[0]);
    const net = await write.getNetwork();
    setChainId(Number(net.chainId));
  };

  // shared pull
  const pullOnce = async () => {
    if (!bingo || pulling.current) return;
    pulling.current = true;
    try {
      const rid: bigint = await bingo.currentRoundId();
      const ridN = Number(rid);
      setCurrentRoundId(ridN);

      if (ridN > 0) {
        const r = (await bingo.roundInfo(rid)) as unknown as RoundInfo;
        setRound(r);
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
        } catch (e) {
          console.warn("ERC20 read error:", e);
        }
      }

      if (bingo && account && ridN > 0) {
        try {
          const players: string[] = await bingo.playersOf(rid);
          setJoined(players.map((p) => p.toLowerCase()).includes(account.toLowerCase()));

          const r2 = (await bingo.roundInfo(rid)) as unknown as RoundInfo;
          if (r2.randomness !== 0n) {
            const raw: number[] = await bingo.cardOf(rid, account);
            setCard(Array.from(raw).map(Number));
          } else {
            setCard([]);
          }
        } catch (e) {
          console.warn("Game state read error:", e);
        }
      } else {
        setJoined(false);
        setCard([]);
      }
    } catch (e) {
      console.error("Polling error:", e);
    } finally {
      pulling.current = false;
    }
  };

  // polling loop (always on; events will force extra pulls)
  useEffect(() => {
    let t: number;
    const loop = async () => {
      await pullOnce();
      t = window.setTimeout(loop, 1500);
    };
    loop();
    return () => window.clearTimeout(t);
  }, [bingo, usdc, account]);

  // event subscriptions (WSS only)
  useEffect(() => {
    if (!events) return;

    const onAny = async (..._args: any[]) => {
      await pullOnce();
    };

    events.on("Draw", onAny);
    events.on("VRFFulfilled", onAny);
    events.on("RoundCreated", onAny);
    events.on("Payout", onAny);

    console.log("[frontend] subscribed to Draw/VRFFulfilled/RoundCreated/Payout");

    return () => {
      events.off("Draw", onAny);
      events.off("VRFFulfilled", onAny);
      events.off("RoundCreated", onAny);
      events.off("Payout", onAny);
    };
  }, [events]);

  // helpers
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
      const tx = await (c as any).approve(
        CONTRACT_ADDRESS,
        parseUnits("1000000000000", decimals)
      );
      await tx.wait();
      await pullOnce();
    } catch (e: any) {
      alert(e?.shortMessage ?? e?.message ?? "Approve failed");
    } finally {
      setLoadingTx("");
    }
  };

  const doJoin = async () => {
    if (!bingo || !round || currentRoundId === 0) return;
    try {
      setLoadingTx("Join...");
      const c = await withSigner(bingo);
      const tx = await (c as any).joinRound(currentRoundId);
      await tx.wait();
      await pullOnce();
    } catch (e: any) {
      alert(e?.shortMessage ?? e?.message ?? "Join failed");
    } finally {
      setLoadingTx("");
    }
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
      return nowSec < Number(round.joinDeadline)
        ? "Join window open"
        : "Waiting for VRF";
    }
    return `Drawing... (${round.drawCount}/${MAX_NUMBER})`;
  }, [round, nowSec]);

  const explorerBase = (cid?: number) =>
    cid === 8453 ? "https://basescan.org" : "https://sepolia.basescan.org";

  return (
    <div style={styles.wrap}>
      <Header />

      <TopBar chainId={chainId} account={account} onConnect={connect} />

      {/* Diagnose banner */}
      {diag.msg && (
        <div style={{background:"#ffecec", border:"1px solid #ffb3b3", padding:12, borderRadius:10, marginBottom:12}}>
          <b>Config issue:</b> {diag.msg}<br/>
          <small>chainId seen: {diag.chainId ?? "?"} • address: {CONTRACT_ADDRESS}</small>
        </div>
      )}

      {!RPC_URL && (
        <div style={{background:"#fff4e5", border:"1px solid #ffd599", padding:12, borderRadius:10, marginBottom:12}}>
          <b>RPC_URL missing.</b> Set VITE_RPC_URL in Vercel and redeploy.
        </div>
      )}
      {!RPC_WSS && (
        <div style={{background:"#eef6ff", border:"1px solid #b3d4ff", padding:12, borderRadius:10, marginBottom:12}}>
          <b>VITE_RPC_WSS not set.</b> Live events will rely on HTTP polling only.
        </div>
      )}

      <section style={styles.hero}>
        <div>
          <h1 style={{ margin: 0, fontSize: 36 }}>BingoBase</h1>
          <p style={{ marginTop: 8, opacity: 0.8 }}>
            Provably fair on-chain Bingo on Base • Chainlink VRF v2.5
          </p>
          <div style={{fontSize:12, opacity:0.7, marginTop:6}}>
            Read via: <b>{readProviderName}</b> · Latest block: <b>{latestBlock || "-"}</b>
          </div>
        </div>
        <img src="/BingoBase4.png" alt="logo" style={{ height: 56 }} />
      </section>

      <section style={styles.columns}>
        {/* Left */}
        <div style={styles.leftCol}>
          <Card title="Main Hall">
            <Row label="Current Round">{currentRoundId || "-"}</Row>
            <Row label="Entry Fee">{entryStr}</Row>
            <Row label="Prize Pool">{prizeStr}</Row>
            <Row label="Start">
              {round
                ? new Date(Number(round.startTime) * 1000).toLocaleString()
                : "-"}
            </Row>
            <Row label="Join Window">
              {round
                ? nowSec < Number(round.joinDeadline)
                  ? `${Math.max(0, Number(round.joinDeadline) - nowSec)}s left`
                  : "Closed"
                : "-"}
            </Row>
            <Row label="Status">{statusText}</Row>

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button
                style={btnPrimary(
                  !!account &&
                    canJoin &&
                    allowance >= (round?.entryFeeUSDC ?? 0n) &&
                    loadingTx === ""
                )}
                disabled={
                  !account ||
                  !canJoin ||
                  loadingTx !== "" ||
                  !round ||
                  allowance < (round?.entryFeeUSDC ?? 0n)
                }
                onClick={doJoin}
                title={
                  !account
                    ? "Connect your wallet"
                    : !canJoin
                    ? "Join window closed or already joined"
                    : allowance < (round?.entryFeeUSDC ?? 0n)
                    ? "Approve USDC first"
                    : ""
                }
              >
                {loadingTx === "Join..." ? "Joining..." : `Join • ${entryStr}`}
              </button>

              <button
                style={btnGhost}
                disabled={!account || loadingTx !== "" || !round}
                onClick={doApprove}
              >
                {loadingTx === "Approve..." ? "Approving..." : `Approve ${symbol}`}
              </button>
            </div>

            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              Wallet balance: {Number(formatUnits(balance, decimals)).toFixed(2)} {symbol} ·{" "}
              Allowance: {Number(formatUnits(allowance, decimals)).toFixed(2)} {symbol}
            </div>
          </Card>

          <Card title="Recent Draws">
            {lastDrawnList.length === 0 ? (
              <div style={{ opacity: 0.6 }}>No draws yet.</div>
            ) : (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {lastDrawnList.map((n) => (
                  <Ball key={n} n={n} active />
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Right */}
        <div style={styles.rightCol}>
          <Card title="Live Board (1–90)">
            <Grid90 drawn={drawnSet} />
          </Card>

          <Card title="Your Card (24)">
            {card.length === 0 ? (
              <div style={{ opacity: 0.7 }}>
                Your card appears after VRF (join first; card is derived deterministically from your address).
              </div>
            ) : (
              <GridCard card={card} drawn={drawnSet} />
            )}
          </Card>
        </div>
      </section>

      <footer style={{ margin: "40px 0", fontSize: 12, opacity: 0.7 }}>
        Contract:{" "}
        <a
          href={`${explorerBase(chainId)}/address/${CONTRACT_ADDRESS}`}
          target="_blank"
        >
          {CONTRACT_ADDRESS}
        </a>{" "}
        · USDC:{" "}
        <a
          href={`${explorerBase(chainId)}/address/${USDC_ADDRESS}`}
          target="_blank"
        >
          {USDC_ADDRESS}
        </a>
      </footer>
    </div>
  );
}

// ===== UI parts =====
function Header() {
  return (
    <div style={{ padding: "10px 0", fontSize: 12, opacity: 0.8 }}>
      <span>Network: Base</span>
    </div>
  );
}

function TopBar({
  account,
  onConnect,
  chainId,
}: {
  account?: string;
  onConnect: () => void;
  chainId?: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 12,
      }}
    >
      <div style={{ fontWeight: 600 }}>Main Hall</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>ChainId: {chainId ?? "-"}</span>
        {account ? (
          <code
            style={{
              fontSize: 12,
              background: "#f4f6fa",
              padding: "6px 10px",
              borderRadius: 8,
            }}
          >
            {account.slice(0, 6)}…{account.slice(-4)}
          </code>
        ) : (
          <button style={btnPrimary(true)} onClick={onConnect}>
            Connect Wallet
          </button>
        )}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: any }) {
  return (
    <div style={styles.card}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: any }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "8px 0",
        borderBottom: "1px solid #eff2f7",
      }}
    >
      <div style={{ opacity: 0.7 }}>{label}</div>
      <div style={{ fontWeight: 600 }}>{children}</div>
    </div>
  );
}

function Grid90({ drawn }: { drawn: Set<number> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 6 }}>
      {Array.from({ length: MAX_NUMBER }, (_, i) => i + 1).map((n) => (
        <div
          key={n}
          style={{
            border: "1px solid #e6eaf2",
            borderRadius: 8,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: drawn.has(n) ? BASE_BLUE : "#fff",
            color: drawn.has(n) ? "#fff" : "#111",
            fontWeight: 600,
          }}
        >
          {n}
        </div>
      ))}
    </div>
  );
}

function GridCard({ card, drawn }: { card: number[]; drawn: Set<number> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
      {card.map((n, idx) => (
        <div
          key={idx}
          style={{
            border: "1px solid #e6eaf2",
            borderRadius: 10,
            height: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: drawn.has(n) ? BASE_BLUE : "#fff",
            color: drawn.has(n) ? "#fff" : "#111",
            fontWeight: 700,
            fontSize: 16,
          }}
        >
          {n}
        </div>
      ))}
    </div>
  );
}

function Ball({ n, active = false }: { n: number; active?: boolean }) {
  return (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: 17,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? BASE_BLUE : "#fff",
        color: active ? "#fff" : "#111",
        border: "1px solid #e6eaf2",
        fontWeight: 700,
      }}
    >
      {n}
    </div>
  );
}

// ===== Styles =====
const styles: Record<string, React.CSSProperties> = {
  wrap: {
    maxWidth: 1080,
    margin: "24px auto",
    padding: "0 16px",
    fontFamily: "Inter, system-ui, Arial",
  },
  hero: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    margin: "8px 0 16px",
  },
  columns: { display: "grid", gridTemplateColumns: "1.1fr .9fr", gap: 16 },
  leftCol: {},
  rightCol: {},
  card: {
    padding: 16,
    border: "1px solid #e6eaf2",
    borderRadius: 16,
    background: "#fff",
    boxShadow: "0 1px 2px rgba(20,20,20,.03)",
    marginBottom: 16,
  },
};

function btnPrimary(enabled: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid transparent",
    cursor: enabled ? "pointer" : "not-allowed",
    background: enabled ? BASE_BLUE : "#d8e0ff",
    color: "#fff",
    fontWeight: 700,
  };
}
const btnGhost: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid #dde3ef",
  cursor: "pointer",
  background: "#fff",
  color: "#111",
  fontWeight: 600,
};
