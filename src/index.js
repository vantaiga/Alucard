// ═══════════════════════════════════════════════════════════════════════════
// FILE 1: src/index.js
// Boot sequencer. 3 env vars. SAB init. Worker threads. Chain detection.
// System-agnostic. Works for Alucard, Aegis, Vulcan, Ares, Vantage, Vanguard.
// ═══════════════════════════════════════════════════════════════════════════
import { Worker, isMainThread, workerData } from 'worker_threads'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── 3 ENV VARS ───────────────────────────────────────────────────────────────
const REQUIRED = ['MODEMPAY_SECRET_KEY', 'PORT', 'DASHBOARD_PASSKEY']
for (const k of REQUIRE D) if (!process.env[k]) {
  console.error(`[BOOT] Missing: ${k}`); process.exit(1)
}

// ── MASTER SAB (4KB shared memory — the nervous system) ──────────────────────
// Layout (Float64 offsets):
//  [0]   propeller level        [1]   daily revenue acc
//  [2-21] min profit/chain      [22-41] flash avail/source
//  [42-61] competition/chain    [62-81] gas gwei/chain
//  [82-101] chain active flags  [102]  crash signal 0-100
//  [103]  treasury balance      [104]  flash reserve (Model1 50%)
//  [105-124] nonces/chain       [125-144] block numbers/chain
//  [145]  overlay queue size    [146]  executions today
//  [147]  ws health flags       [148]  sovereign state
//  [149]  v7 active flag        [150]  system uptime seconds
// Ring buffer for NEXUS→APEX directives: bytes 1224-4096 (2872 bytes = 44 directives × 65 bytes)

const SAB = new SharedArrayBuffer(4096)
const HOT = new Float64Array(SAB)
const RING = new Uint8Array(SAB, 1224)   // directive ring buffer
const NONCE = new Int32Array(SAB, 840)   // nonces at byte 840 (105×8)

// Default propeller: P5
HOT[0] = 5
HOT[102] = 0  // crash signal
HOT[104] = 0  // flash reserve starts at 0, grows from Model 1

// ── CHAIN DETECTION ───────────────────────────────────────────────────────────
// C/R METHOD: 20 hardcoded Alchemy endpoints. Additional chains auto-detect.
const ALCHEMY_RE = /^https:\/\/([a-z0-9-]+)\.g\.alchemy\.com\/v2\/([A-Za-z0-9_-]+)$/
const CHAIN_META = {
  'eth-mainnet':      { id:1,         native:'ETH', blocks:7200,   flashB:8200, aave:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'polygon-mainnet':  { id:137,       native:'POL', blocks:40754,  flashB:1800, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'arb-mainnet':      { id:42161,     native:'ETH', blocks:345600, flashB:2100, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'base-mainnet':     { id:8453,      native:'ETH', blocks:43200,  flashB:1400, aave:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'opt-mainnet':      { id:10,        native:'ETH', blocks:43200,  flashB:1100, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'bnb-mainnet':      { id:56,        native:'BNB', blocks:28328,  flashB:1500, aave:null,                                           balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'avax-mainnet':     { id:43114,     native:'AVAX',blocks:42146,  flashB:1200, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'blast-mainnet':    { id:81457,     native:'ETH', blocks:43200,  flashB:800,  aave:null,                                           balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'zksync-mainnet':   { id:324,       native:'ETH', blocks:43200,  flashB:900,  aave:null,                                           balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'scroll-mainnet':   { id:534352,    native:'ETH', blocks:28800,  flashB:600,  aave:null,                                           balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'linea-mainnet':    { id:59144,     native:'ETH', blocks:43200,  flashB:700,  aave:null,                                           balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'mantle-mainnet':   { id:5000,      native:'MNT', blocks:43200,  flashB:500,  aave:null,                                           balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'gnosis-mainnet':   { id:100,       native:'XDAI',blocks:16941,  flashB:400,  aave:null,                                           balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'worldchain-mainnet':{ id:480,      native:'ETH', blocks:43200,  flashB:300,  aave:null,                                           balancer:null,                                        mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'berachain-mainnet':{ id:80094,     native:'BERA',blocks:43200,  flashB:600,  aave:null,                                           balancer:null,                                        mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'unichain-mainnet': { id:1301,      native:'ETH', blocks:43200,  flashB:500,  aave:null,                                           balancer:null,                                        mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'sei-mainnet':      { id:1329,      native:'SEI', blocks:345600, flashB:800,  aave:null,                                           balancer:null,                                        mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'sonic-mainnet':    { id:146,       native:'S',   blocks:172800, flashB:700,  aave:null,                                           balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8', mc3:'0xcA11bde05977b3631167028862bE2a173976CA11' },
  'solana-mainnet':   { id:0,         native:'SOL', blocks:172800, flashB:1200, aave:null,                                           balancer:null,                                        mc3:null },
}

export function detectChains() {
  const chains = []
  for (const [, v] of Object.entries(process.env)) {
    const m = v?.match?.(ALCHEMY_RE); if (!m) continue
    const meta = CHAIN_META[m[1]]
    if (!meta) continue
    chains.push({ name:m[1], http:v, ws:v.replace('https://','wss://'), key:m[2], ...meta })
  }
  chains.sort((a,b) => b.blocks - a.blocks)
  const totalCycles = chains.reduce((s,c) => s + c.blocks, 0)
  const totalFlash  = chains.reduce((s,c) => s + c.flashB, 0) * 1e6
  HOT[22] = totalFlash   // flash available in SAB
  console.log(`[BOOT] ${chains.length} chains | ${totalCycles.toLocaleString()} cycles/day | $${(totalFlash/1e9).toFixed(2)}B flash`)
  return chains
}

// ── WORKER THREAD SPAWNER ──────────────────────────────────────────────────────
function spawn(file, extra={}) {
  const w = new Worker(new URL(file, import.meta.url), { workerData:{ SAB, ...extra } })
  w.on('error', e  => { console.error(`[${file}] error:`, e.message); setTimeout(()=>spawn(file,extra),1000) })
  w.on('exit',  c  => { if(c!==0) setTimeout(()=>spawn(file,extra),1000) })
  return w
}

// ── MAIN ───────────────────────────────────────────────────────────────────────
if (isMainThread) {
  console.log('[BOOT] ALUCARD — Sovereign DeFi Protocol')
  console.log('[BOOT] Operator: Bun Omar Secka')
  console.log('[BOOT] Treasury: 0xCCCF1C9A2154750A0D7CceeD51fE0f9b4c1906e8')
  console.log('[BOOT] Executor: 0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39')

  const { initDB }      = await import('./db.js')
  const { initOverlay } = await import('./overlay.js')
  await initDB()
  await initOverlay()

  const chains = detectChains()

  spawn('./chains.js',    { chains })
  spawn('./nexus.js')
  spawn('./apex.js')
  spawn('./sovereign.js')

  const { startDashboard } = await import('./dashboard.js')
  const { startRS }        = await import('./rs_engine.js')
  const { startTreasury }  = await import('./treasury.js')
  startDashboard(SAB, chains)
  startRS(SAB)
  startTreasury(SAB)

  setInterval(() => { HOT[150]++ }, 1000)
  process.on('uncaughtException',  e => console.error('[BOOT] Uncaught:',  e.message))
  process.on('unhandledRejection', r => console.error('[BOOT] Rejection:', String(r).slice(0,100)))
  process.on('SIGTERM', () => { console.log('[BOOT] Graceful exit'); process.exit(0) })
  console.log(`[BOOT] Operational in ${process.uptime().toFixed(2)}s`)
}
