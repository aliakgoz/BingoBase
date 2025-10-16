import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";

// === ENV ===
const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS as string;
const USDC_ADDRESS     = import.meta.env.VITE_USDC_ADDRESS as string;
const RPC_URL          = (import.meta.env.VITE_RPC_URL as string) || "";

const BASE_BLUE = "#0052FF"; // Base mavi tonu
const MAX_NUMBER = 90;
const CARD_SIZE = 24;

// === Minimal ABIs ===
// BaseBingo25 (güncel versiyon)
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

  // actions
  "function joinRound(uint256 roundId) external",
  "function requestRandomness(uint256 roundId) external",
  "function drawNext(uint256 roundId) external",
  "function claimBingo(uint256 roundId) external",

  // events (sadece UI içi log/debug için)
  "event Joined(uint256 indexed roundId, address indexed player, uint256 paidUSDC)",
  "event Draw(uint256 indexed roundId, uint8 number, uint8 drawIndex)",
];

// ERC20 (USDC)
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
  // okuma için RPC (hızlı ve cüzdana gerek yok)
  const read = useMemo(() => (RPC_URL ? new JsonRpcProvider(RPC_URL) : undefined), []);
  // yazma için wallet provider (Metamask)
  const [write, setWrite] = useState<BrowserProvider>();

  useEffect(() => {
    if ((window as any).ethereum) {
      setWrite(new BrowserProvider((window as any).ethereum));
    }
  }, []);

  return { read, write };
}

export default function App() {
  const { read, write } = useProviders();

  // cüzdan
  const [account, setAccount] = useState<string>("");
  const [chainId, setChainId] = useState<number>();

  // sözleşmeler
  const [bingo, setBingo] = useState<Contract>();
  const [usdc, setUsdc] = useState<Contract>();

  // durumlar
  const [currentRoundId, setCurrentRoundId] = useState<number>(0);
  const [round, setRound] = useState<RoundInfo>();
  const [symbol, setSymbol] = useState<string>("USDC");
  const [decimals, setDecimals] = useState<number>(6);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [balance, setBalance] = useState<bigint>(0n);
  const [joined, setJoined] = useState<boolean>(false);
  const [card, setCard] = useState<number[]>([]);
  const [loadingTx, setLoadingTx] = useState<string>("");

  // --- helpers ---
  const nowSec = Math.floor(Date.now() / 1000);
  const canJoin = useMemo(() => {
    if (!round) return false;
    return Number(round.startTime) <= nowSec && nowSec < Number(round.joinDeadline) && !joined && !round.finalized;
  }, [round, joined, nowSec]);

  const joinLeftSec = useMemo(() => {
    if (!round) return 0;
    const left = Number(round.joinDeadline) - nowSec;
    return Math.max(0, left);
  }, [round, nowSec]);

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

  const lastDrawnList = useMemo(() => {
    return Array.from(drawnSet).sort((a, b) => a - b).slice(-10);
  }, [drawnSet]);

  // ---- init contracts (read) ----
  useEffect(() => {
    if (!read || !CONTRACT_ADDRESS) return;
    const bingoR = new Contract(CONTRACT_ADDRESS, BINGO_ABI, read);
    setBingo(bingoR);

    // USDC adresi env'den, yoksa kontrattan da okunabilir
    const usdcAddr = USDC_ADDRESS;
    if (usdcAddr) {
      const usdcR = new Contract(usdcAddr, ERC20_ABI, read);
      setUsdc(usdcR);
    }
  }, [read]);

  // ---- wallet connect ----
  const connect = async () => {
    if (!write) return alert("Wallet bulunamadı.");
    const accs = await write.send("eth_requestAccounts", []);
    setAccount(accs[0]);
    const net = await write.getNetwork();
    setChainId(Number(net.chainId));
  };

  // ---- data polling ----
  useEffect(() => {
    let t: number;
    const pull = async () => {
      if (!bingo) return;

      const rid: bigint = await bingo.currentRoundId();
      setCurrentRoundId(Number(rid));

      if (Number(rid) > 0) {
        const r = (await bingo.roundInfo(rid)) as unknown as RoundInfo;
        setRound(r);
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
        } catch {}
      }

      if (bingo && account && Number(rid) > 0) {
        const players: string[] = await bingo.playersOf(rid);
        setJoined(players.map(p => p.toLowerCase()).includes(account.toLowerCase()));

        // randomness geldiyse kartı çek
        const r = (await bingo.roundInfo(rid)) as unknown as RoundInfo;
        if (r.randomness !== 0n) {
          const raw = await bingo.cardOf(rid, account);
          setCard(Array.from(raw).map(Number));
        } else {
          setCard([]);
        }
      }
      t = window.setTimeout(pull, 5000);
    };
    pull();
    return () => window.clearTimeout(t);
  }, [bingo, usdc, account]);

  // ---- actions ----
  const withSigner = async (c: Contract) => {
    if (!write) throw new Error("Wallet yok");
    const signer = await write.getSigner();
    return c.connect(signer);
    };

  const doApprove = async () => {
    if (!usdc) return;
    try {
      setLoadingTx("Approve...");
      const c = await withSigner(usdc);
      // geniş bir allowance veriyoruz (1e12 USDC)
      const tx = await c.approve(CONTRACT_ADDRESS, parseUnits("1000000000000", decimals));
      await tx.wait();
    } catch (e:any) {
      alert(e?.message ?? "Approve hata");
    } finally {
      setLoadingTx("");
    }
  };

  const doJoin = async () => {
    if (!bingo || !round || currentRoundId === 0) return;
    try {
      setLoadingTx("Join...");
      const c = await withSigner(bingo);
      const tx = await c.joinRound(currentRoundId);
      await tx.wait();
    } catch (e:any) {
      // revert mesajını göstermek için
      alert(e?.shortMessage ?? e?.message ?? "Join failed");
    } finally {
      setLoadingTx("");
    }
  };

  const doRequestRandomness = async () => {
    if (!bingo || currentRoundId === 0) return;
    try {
      setLoadingTx("Request VRF...");
      const c = await withSigner(bingo);
      const tx = await c.requestRandomness(currentRoundId);
      await tx.wait();
    } catch (e:any) {
      alert(e?.shortMessage ?? e?.message ?? "VRF request failed");
    } finally {
      setLoadingTx("");
    }
  };

  const doDrawNext = async () => {
    if (!bingo || currentRoundId === 0) return;
    try {
      setLoadingTx("Draw...");
      const c = await withSigner(bingo);
      const tx = await c.drawNext(currentRoundId);
      await tx.wait();
    } catch (e:any) {
      alert(e?.shortMessage ?? e?.message ?? "Draw failed");
    } finally {
      setLoadingTx("");
    }
  };

  const doClaim = async () => {
    if (!bingo || currentRoundId === 0) return;
    try {
      setLoadingTx("Claim...");
      const c = await withSigner(bingo);
      const tx = await c.claimBingo(currentRoundId);
      await tx.wait();
    } catch (e:any) {
      alert(e?.shortMessage ?? e?.message ?? "Claim failed");
    } finally {
      setLoadingTx("");
    }
  };

  const entryStr = round ? `${Number(formatUnits(round.entryFeeUSDC, decimals))} ${symbol}` : "-";
  const prizeStr = round ? `${Number(formatUnits(round.prizePoolUSDC, decimals)).toFixed(2)} ${symbol}` : "-";

  return (
    <div style={styles.wrap}>
      <Header />

      <TopBar
        chainId={chainId}
        account={account}
        onConnect={connect}
      />

      <section style={styles.hero}>
        <div>
          <h1 style={{margin:0,fontSize:36}}>BingoBase</h1>
          <p style={{marginTop:8,opacity:.8}}>
            Provably-fair on-chain Bingo on Base • Chainlink VRF v2.5
          </p>
        </div>
        <img src="/BingoBase4.png" alt="logo" style={{height:56}} />
      </section>

      <section style={styles.columns}>
        {/* Left: Round / actions */}
        <div style={styles.leftCol}>
          <Card title="Main Hall">
            <Row label="Current Round">{currentRoundId || "-"}</Row>
            <Row label="Entry Fee">{entryStr}</Row>
            <Row label="Prize Pool">{prizeStr}</Row>
            <Row label="Start">
              {round ? new Date(Number(round.startTime) * 1000).toLocaleString() : "-"}
            </Row>
            <Row label="Join Closes In">
              {round ? (joinLeftSec > 0 ? `${joinLeftSec}s` : "Closed") : "-"}
            </Row>
            <Row label="Draw Count">{round?.drawCount ?? 0} / {MAX_NUMBER}</Row>
            <Row label="Status">
              {round?.finalized ? "Finalized" : round?.randomness === 0n ? "Waiting VRF" : "Live"}
            </Row>

            <div style={{display:"flex", gap:8, marginTop:12, flexWrap:"wrap"}}>
              <button
                style={btnPrimary(canJoin && allowance >= (round?.entryFeeUSDC ?? 0n))}
                disabled={!account || !canJoin || loadingTx !== "" || !round}
                onClick={doJoin}
                title={!account ? "Connect wallet" : !canJoin ? "Join window kapalı veya zaten katıldın" : ""}
              >
                {loadingTx === "Join..." ? "Joining..." : `Join • ${entryStr}`}
              </button>

              <button
                style={btnGhost}
                disabled={!account || loadingTx !== ""}
                onClick={doApprove}
              >
                {loadingTx === "Approve..." ? "Approving..." : `Approve ${symbol}`}
              </button>

              <button
                style={btnGhost}
                disabled={!account || loadingTx !== "" || !round || Number(round.joinDeadline) > nowSec}
                onClick={doRequestRandomness}
                title="Join kapandıktan sonra VRF iste"
              >
                {loadingTx === "Request VRF..." ? "Requesting..." : "Request VRF"}
              </button>

              <button
                style={btnGhost}
                disabled={!account || loadingTx !== "" || !round || round.randomness === 0n}
                onClick={doDrawNext}
              >
                {loadingTx === "Draw..." ? "Drawing..." : "Draw Next"}
              </button>

              <button
                style={btnGhost}
                disabled={!account || loadingTx !== "" || !round || round.randomness === 0n}
                onClick={doClaim}
              >
                {loadingTx === "Claim..." ? "Claiming..." : "Claim Bingo"}
              </button>
            </div>

            <div style={{marginTop:8, fontSize:12, opacity:.7}}>
              Cüzdan bakiyen: {Number(formatUnits(balance, decimals)).toFixed(2)} {symbol} •
              Allowance: {Number(formatUnits(allowance, decimals)).toFixed(2)} {symbol}
            </div>
          </Card>

          <Card title="Last Drawn">
            {lastDrawnList.length === 0 ? (
              <div style={{opacity:.6}}>Henüz çekiliş yok.</div>
            ) : (
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {lastDrawnList.map(n => <Ball key={n} n={n} active />)}
              </div>
            )}
          </Card>
        </div>

        {/* Right: Boards */}
        <div style={styles.rightCol}>
          <Card title="Live Board (1-90)">
            <Grid90 drawn={drawnSet}/>
          </Card>

          <Card title="Your Card (24)">
            {card.length === 0 ? (
              <div style={{opacity:.7}}>Kartın VRF sonrası oluşur (join + randomness).</div>
            ) : (
              <GridCard card={card} drawn={drawnSet}/>
            )}
          </Card>
        </div>
      </section>

      <footer style={{margin:"40px 0", fontSize:12, opacity:.7}}>
        Contract: <a href={`https://sepolia.basescan.org/address/${CONTRACT_ADDRESS}`} target="_blank">{CONTRACT_ADDRESS}</a> ·{" "}
        USDC: <a href={`https://sepolia.basescan.org/address/${USDC_ADDRESS}`} target="_blank">{USDC_ADDRESS}</a>
      </footer>
    </div>
  );
}

// ========== UI PARTS ==========
function Header() {
  return (
    <div style={{padding:"10px 0", fontSize:12, opacity:.8}}>
      <span>Network: Base Sepolia</span>
    </div>
  );
}

function TopBar({ account, onConnect, chainId }: { account?: string, onConnect: ()=>void, chainId?: number }) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12}}>
      <div style={{fontWeight:600}}>Main Hall</div>
      <div style={{display:"flex", gap:12, alignItems:"center"}}>
        <span style={{fontSize:12, opacity:.7}}>ChainId: {chainId ?? "-"}</span>
        {account ? (
          <code style={{fontSize:12, background:"#f4f6fa", padding:"6px 10px", borderRadius:8}}>
            {account.slice(0,6)}…{account.slice(-4)}
          </code>
        ) : (
          <button style={btnPrimary(true)} onClick={onConnect}>Connect Wallet</button>
        )}
      </div>
    </div>
  );
}

function Card({ title, children }:{ title:string, children:any }) {
  return (
    <div style={styles.card}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12}}>
        <h3 style={{margin:0, fontSize:18}}>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Row({label, children}:{label:string, children:any}) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #eff2f7"}}>
      <div style={{opacity:.7}}>{label}</div>
      <div style={{fontWeight:600}}>{children}</div>
    </div>
  );
}

function Grid90({ drawn }:{ drawn:Set<number> }) {
  return (
    <div style={{display:"grid", gridTemplateColumns:"repeat(10, 1fr)", gap:6}}>
      {Array.from({length:MAX_NUMBER}, (_,i)=>i+1).map(n => (
        <div key={n} style={{
          border:"1px solid #e6eaf2",
          borderRadius:8,
          height:32,
          display:"flex",alignItems:"center",justifyContent:"center",
          background: drawn.has(n) ? BASE_BLUE : "#fff",
          color: drawn.has(n) ? "#fff" : "#111",
          fontWeight:600
        }}>
          {n}
        </div>
      ))}
    </div>
  );
}

function GridCard({ card, drawn }:{ card:number[], drawn:Set<number> }) {
  return (
    <div style={{display:"grid", gridTemplateColumns:"repeat(6, 1fr)", gap:8}}>
      {card.map((n,idx)=>(
        <div key={idx} style={{
          border:"1px solid #e6eaf2",
          borderRadius:10,
          height:44,
          display:"flex",alignItems:"center",justifyContent:"center",
          background: drawn.has(n) ? BASE_BLUE : "#fff",
          color: drawn.has(n) ? "#fff" : "#111",
          fontWeight:700,
          fontSize:16
        }}>
          {n}
        </div>
      ))}
    </div>
  );
}

function Ball({ n, active=false }:{ n:number, active?:boolean }) {
  return (
    <div style={{
      width:34, height:34, borderRadius:17,
      display:"flex", alignItems:"center", justifyContent:"center",
      background: active ? BASE_BLUE : "#fff",
      color: active ? "#fff" : "#111",
      border:"1px solid #e6eaf2",
      fontWeight:700
    }}>
      {n}
    </div>
  );
}

// ========== STYLES ==========
const styles: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 1080, margin: "24px auto", padding: "0 16px", fontFamily: "Inter, system-ui, Arial" },
  hero: { display:"flex", alignItems:"center", justifyContent:"space-between", margin:"8px 0 16px" },
  columns: { display:"grid", gridTemplateColumns:"1.1fr .9fr", gap:16 },
  leftCol: {},
  rightCol: {},
  card: {
    padding:16, border:"1px solid #e6eaf2", borderRadius:16, background:"#fff",
    boxShadow:"0 1px 2px rgba(20,20,20,.03)", marginBottom:16
  },
};

function btnPrimary(enabled:boolean): React.CSSProperties {
  return {
    padding:"10px 14px",
    borderRadius:10,
    border:"1px solid transparent",
    cursor: enabled ? "pointer" : "not-allowed",
    background: enabled ? BASE_BLUE : "#d8e0ff",
    color:"#fff",
    fontWeight:700
  };
}
const btnGhost: React.CSSProperties = {
  padding:"10px 14px",
  borderRadius:10,
  border:"1px solid #dde3ef",
  cursor:"pointer",
  background:"#fff",
  color:"#111",
  fontWeight:600
};
