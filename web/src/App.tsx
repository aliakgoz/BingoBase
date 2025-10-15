export default function App() {
  return (
    <main style={{maxWidth:880,margin:"40px auto",fontFamily:"Inter,system-ui,Arial"}}>
      <h1>BingoBase</h1>
      <p>Provably-fair on-chain Bingo on Base, powered by Chainlink VRF v2.5.</p>

      <ul>
        <li>Network: Base Sepolia → Base Mainnet (yakında)</li>
        <li>VRF: v2.5 subscription</li>
      </ul>

      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginTop:16}}>
        <a href="https://github.com/aliakgoz/BingoBase" target="_blank">GitHub</a>
        <a href="https://basescan.org/" target="_blank">BaseScan</a>
      </div>

      <hr style={{margin:"24px 0"}}/>

      <h2>How it works</h2>
      <ol>
        <li>Create & join rounds</li>
        <li>VRF randomness → draw numbers</li>
        <li>Claim Bingo, auto-verified</li>
      </ol>
    </main>
  );
}
