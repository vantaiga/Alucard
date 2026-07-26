// src/index.js — REDRAFT: fixed SAB (global, no import), fixed Worker pattern,
// fixed dynamic imports (static at top), Railway free tier safe
import { Worker, isMainThread } from 'worker_threads'
import { fileURLToPath }        from 'url'
import path                     from 'path'
import { existsSync, mkdirSync } from 'fs'
import { initDB }               from './db.js'
import { initOverlay }          from './overlay.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── ENV VALIDATION ─────────────────────────────────────────────────────────────
const REQUIRED = ['MODEMPAY_SECRET_KEY', 'PORT', 'DASHBOARD_PASSKEY']
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`[BOOT] Missing required env var: ${k}`); process.exit(1) }
}

// ── MASTER SAB (4KB — the shared nervous system, NO import needed — global) ────
// SharedArrayBuffer is a Node.js global. No import. No 'buffer' module.
const SAB  = new SharedArrayBuffer(4096)
const HOT  = new Float64Array(SAB)      // float state: propeller, revenue, gas, etc.
const SIG  = new Int32Array(SAB)        // signal flags: [0]=chains→nexus, [1]=nexus→apex

// SAB layout (Float64 offsets × 8 bytes each):
// [0]  propeller level          [1]  daily revenue acc (USD)
// [2]  flash base ($45.59B)     [3]  flash reserve (Model1 50%)
// [4]  crash signal (0-100)     [5]  total treasury balance
// [6]  overlay queue size       [7]  executions today
// [8]  system uptime (seconds)  [9]  v7 active (0/1)
// [10-29] gas gwei per chain    [30-49] chain active flag (0/1)
// [50-69] competition per chain [70-89] nonce per chain (also Int32 at offset 560)
// [90]  propeller target (USD/day — computed from level)
// [100-149] ring buffer control

// Default state
HOT[0]  = 5        // P5 default propeller
HOT[2]  = 45.59e9  // $45.59B base flash capacity
HOT[3]  = 0        // Model 1 reserve starts at 0
HOT[4]  = 0        // crash signal

// ── CHAIN DETECTION ────────────────────────────────────────────────────────────
// Hardcoded 20 Alchemy endpoints + auto-detect additional from env vars
const ALCHEMY_RE = /^https:\/\/([a-z0-9-]+)\.g\.alchemy\.com\/v2\/([A-Za-z0-9_-]+)$/

const CHAIN_META = {
  'eth-mainnet':       { id:1,       native:'ETH', blocks:7200,   flashB:8200, aave:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'polygon-mainnet':   { id:137,     native:'POL', blocks:40754,  flashB:1800, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'arb-mainnet':       { id:42161,   native:'ETH', blocks:345600, flashB:2100, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'base-mainnet':      { id:8453,    native:'ETH', blocks:43200,  flashB:1400, aave:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'opt-mainnet':       { id:10,      native:'ETH', blocks:43200,  flashB:1100, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'bnb-mainnet':       { id:56,      native:'BNB', blocks:28328,  flashB:1500, aave:null,                                          balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'avax-mainnet':      { id:43114,   native:'AVAX',blocks:42146,  flashB:1200, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'blast-mainnet':     { id:81457,   native:'ETH', blocks:43200,  flashB:800,  aave:null,                                          balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'zksync-mainnet':    { id:324,     native:'ETH', blocks:43200,  flashB:900,  aave:null,                                          balancer:'0xBA12222222228d8Ba445958a75a0104d566BF2C8' },
  'scroll-mainnet':    { id:534352,  native:'ETH', blocks:28800,  flashB:600,  aave:null,                                          balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'linea-mainnet':     { id:59144,   native:'ETH', blocks:43200,  flashB:700,  aave:null,                                          balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'mantle-mainnet':    { id:5000,    native:'MNT', blocks:43200,  flashB:500,  aave:null,                                          balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'gnosis-mainnet':    { id:100,     native:'XDAI',blocks:16941,  flashB:400,  aave:null,                                          balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'worldchain-mainnet':{ id:480,     native:'ETH', blocks:43200,  flashB:300,  aave:null,                                          balancer:null },
  'berachain-mainnet': { id:80094,   native:'BERA',blocks:43200,  flashB:600,  aave:null,                                          balancer:null },
  'unichain-mainnet':  { id:1301,    native:'ETH', blocks:43200,  flashB:500,  aave:null,                                          balancer:null },
  'sei-mainnet':       { id:1329,    native:'SEI', blocks:345600, flashB:800,  aave:null,                                          balancer:null },
  'sonic-mainnet':     { id:146,     native:'S',   blocks:172800, flashB:700,  aave:null,                                          balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8' },
  'solana-mainnet':    { id:0,       native:'SOL', blocks:172800, flashB:1200, aave:null,                                          balancer:null },
}

export function detectChains() {
  const found = []
  for (const [, v] of Object.entries(process.env)) {
    const m = v?.match?.(ALCHEMY_RE)
    if (!m) continue
    const meta = CHAIN_META[m[1]]
    if (!meta) continue
    found.push({ name:m[1], http:v, ws:v.replace('https://','wss://'), key:m[2], ...meta })
  }
  found.sort((a,b) => b.blocks - a.blocks)
  const totalCycles = found.reduce((s,c) => s + c.blocks, 0)
  const totalFlash  = found.reduce((s,c) => s + c.flashB, 0) * 1e6
  HOT[2] = totalFlash
  console.log(`[BOOT] ${found.length} chains | ${totalCycles.toLocaleString()} cycles/day | $${(totalFlash/1e9).toFixed(2)}B base flash`)
  return found
}

// ── WORKER SPAWNER ─────────────────────────────────────────────────────────────
function spawn(filePath, extra = {}) {
  // Pass SAB as transferable (not extra data copy)
  const w = new Worker(new URL(filePath, import.meta.url), {
    workerData: { SAB, ...extra }
  })
  const name = path.basename(filePath)
  w.on('error',   e => { console.error(`[${name}] error: ${e.message}`) })
  w.on('exit',    c => { if (c !== 0) { console.warn(`[${name}] exited ${c} — restart in 1s`); setTimeout(() => spawn(filePath, extra), 1000) } })
  w.on('message', m => { if (process.env.DEBUG) console.log(`[${name}] msg:`, m) })
  return w
}

// ── BOOT ───────────────────────────────────────────────────────────────────────
if (isMainThread) {
  console.log('╔═══════════════════════════════════════════════╗')
  console.log('║           A L U C A R D                      ║')
  console.log('║     Sovereign DeFi Protocol v1.0             ║')
  console.log('║     Operator: Bun Omar Secka                 ║')
  console.log('╚═══════════════════════════════════════════════╝')

  // Init DB first (all other modules depend on it)
  await initDB()
  await initOverlay()

  const chains = detectChains()
  if (!chains.length) console.warn('[BOOT] No Alchemy URLs found in env — add NAME-mainnet.g.alchemy.com URLs')

  // Spawn worker threads (each owns its domain)
  spawn('./chains.js',   { chains })
  spawn('./nexus.js')
  spawn('./apex.js')
  spawn('./sovereign.js')

  // Main thread: dashboard + treasury + RS engine (these don't need Worker isolation)
  const { startDashboard } = await import('./dashboard.js')
  const { startRS }        = await import('./rs_engine.js')
  const { startTreasury }  = await import('./treasury.js')

  startDashboard(SAB, chains)
  startRS(SAB)
  startTreasury(SAB)

  // Uptime counter
  setInterval(() => { HOT[8]++ }, 1000)

  // Midnight reset of daily revenue accumulator
  const midnight = () => {
    const now  = new Date()
    const next = new Date(); next.setUTCHours(0,0,0,0); next.setUTCDate(next.getUTCDate()+1)
    setTimeout(() => { HOT[1] = 0; console.log('[BOOT] Daily revenue counter reset'); midnight() }, next - now)
  }
  midnight()

  // Health endpoint (for Railway healthcheck)
  const { createServer } = await import('http')
  createServer((req,res) => {
    if (req.url === '/health') { res.writeHead(200); res.end(JSON.stringify({ ok:true, uptime:HOT[8], propeller:HOT[0] })) }
    else { res.writeHead(404); res.end() }
  }).listen(parseInt(process.env.HEALTH_PORT||'3001'))

  // Global error handlers — never crash
  process.on('uncaughtException',  e => console.error('[BOOT] Uncaught:', e.message))
  process.on('unhandledRejection', r => console.error('[BOOT] Rejection:', String(r).slice(0,120)))
  process.on('SIGTERM', () => { console.log('[BOOT] SIGTERM — graceful exit'); process.exit(0) })

  console.log(`[BOOT] System operational in ${process.uptime().toFixed(2)}s`)
  console.log(`[BOOT] Dashboard: http://localhost:${process.env.PORT||3000}`)
}
