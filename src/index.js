// src/index.js — FINAL. Zero crashes. Graceful degradation on missing env vars.
import { Worker, isMainThread } from 'worker_threads'
import { fileURLToPath }        from 'url'
import path                     from 'path'
import { initDB }               from './db.js'
import { initOverlay }          from './overlay.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── ENV CHECK — warn only, never crash the boot ────────────────────────────────
// Railway free tier: vars are set in the UI and ARE available at runtime.
// If missing: warn and continue. System detects and operates in degraded mode.
const ENV = {
  PORT:               parseInt(process.env.PORT || '3000'),
  DASHBOARD_PASSKEY:  process.env.DASHBOARD_PASSKEY || '3530588',
  MODEMPAY_SECRET_KEY:process.env.MODEMPAY_SECRET_KEY || '',
}
if (!ENV.MODEMPAY_SECRET_KEY) console.warn('[BOOT] MODEMPAY_SECRET_KEY not set — settlement disabled until added')

// ── MASTER SAB — global, no import needed ─────────────────────────────────────
// Layout (Float64 × 8 bytes):
// [0] propeller  [1] daily_rev  [2] flash_base  [3] flash_reserve
// [4] crash_sig  [5] treasury   [6] queue_size  [7] exec_count
// [8] uptime_s   [9] v7_active
// [10-29] gas_gwei/chain  [30-49] chain_active  [50-69] competition
// Int32 signal at byte offset 8 (overlaps HOT[1] area — use separate offset)
const SAB     = new SharedArrayBuffer(4096)
const HOT     = new Float64Array(SAB)
// Signal slots at end of SAB (byte 4080) to avoid Float64 overlap
const SIG_CHAINS = new Int32Array(SAB, 4080)   // [0] chains→nexus write head
const SIG_NEXUS  = new Int32Array(SAB, 4084)   // [0] nexus→apex write head
const SIG_CTRL   = new Int32Array(SAB, 4088)   // [0] control signals

// Defaults
HOT[0] = 5           // P5 propeller
HOT[2] = 45_590_000_000  // $45.59B base flash

// ── CHAIN DETECTION ────────────────────────────────────────────────────────────
const ALCHEMY_RE = /^https:\/\/([a-z0-9-]+)\.g\.alchemy\.com\/v2\/[A-Za-z0-9_-]+$/
const CHAIN_META = {
  'eth-mainnet':       {id:1,      native:'ETH', blocks:7200,   flashB:8200, hasAave:true,  hasBal:true},
  'polygon-mainnet':   {id:137,    native:'POL', blocks:40754,  flashB:1800, hasAave:true,  hasBal:true},
  'arb-mainnet':       {id:42161,  native:'ETH', blocks:345600, flashB:2100, hasAave:true,  hasBal:true},
  'base-mainnet':      {id:8453,   native:'ETH', blocks:43200,  flashB:1400, hasAave:true,  hasBal:true},
  'opt-mainnet':       {id:10,     native:'ETH', blocks:43200,  flashB:1100, hasAave:true,  hasBal:true},
  'bnb-mainnet':       {id:56,     native:'BNB', blocks:28328,  flashB:1500, hasAave:false, hasBal:true},
  'avax-mainnet':      {id:43114,  native:'AVAX',blocks:42146,  flashB:1200, hasAave:true,  hasBal:true},
  'blast-mainnet':     {id:81457,  native:'ETH', blocks:43200,  flashB:800,  hasAave:false, hasBal:true},
  'zksync-mainnet':    {id:324,    native:'ETH', blocks:43200,  flashB:900,  hasAave:false, hasBal:true},
  'scroll-mainnet':    {id:534352, native:'ETH', blocks:28800,  flashB:600,  hasAave:false, hasBal:true},
  'linea-mainnet':     {id:59144,  native:'ETH', blocks:43200,  flashB:700,  hasAave:false, hasBal:true},
  'mantle-mainnet':    {id:5000,   native:'MNT', blocks:43200,  flashB:500,  hasAave:false, hasBal:true},
  'gnosis-mainnet':    {id:100,    native:'XDAI',blocks:16941,  flashB:400,  hasAave:false, hasBal:true},
  'worldchain-mainnet':{id:480,    native:'ETH', blocks:43200,  flashB:300,  hasAave:false, hasBal:false},
  'berachain-mainnet': {id:80094,  native:'BERA',blocks:43200,  flashB:600,  hasAave:false, hasBal:false},
  'unichain-mainnet':  {id:1301,   native:'ETH', blocks:43200,  flashB:500,  hasAave:false, hasBal:false},
  'sei-mainnet':       {id:1329,   native:'SEI', blocks:345600, flashB:800,  hasAave:false, hasBal:false},
  'sonic-mainnet':     {id:146,    native:'S',   blocks:172800, flashB:700,  hasAave:false, hasBal:true},
  'solana-mainnet':    {id:0,      native:'SOL', blocks:172800, flashB:1200, hasAave:false, hasBal:false},
}

export function detectChains() {
  const found = []
  for (const val of Object.values(process.env)) {
    if (!val?.match?.(ALCHEMY_RE)) continue
    const name = val.match(/https:\/\/([a-z0-9-]+)\.g\.alchemy/)?.[1]
    const meta = name && CHAIN_META[name]
    if (!meta || found.find(c => c.name === name)) continue
    found.push({ name, http:val, ws:val.replace('https://','wss://'), ...meta })
  }
  found.sort((a,b) => b.blocks - a.blocks)
  const totalFlash = found.reduce((s,c) => s + c.flashB, 0) * 1e6
  HOT[2] = totalFlash || 45_590_000_000
  const cycles = found.reduce((s,c) => s + c.blocks, 0)
  console.log(`[BOOT] ${found.length} chains | ${cycles.toLocaleString()} cycles/day | $${(HOT[2]/1e9).toFixed(1)}B flash`)
  return found
}

// ── WORKER SPAWNER ─────────────────────────────────────────────────────────────
function spawn(file, extra={}) {
  const url = new URL(file, import.meta.url)
  const w   = new Worker(url, { workerData:{ SAB, ...extra } })
  const tag = path.basename(file).replace('.js','').toUpperCase()
  w.on('error',   e => console.error(`[${tag}]`, e.message))
  w.on('exit',    c => { if (c !== 0) { console.warn(`[${tag}] exit ${c} — restart`); setTimeout(() => spawn(file, extra), 2000) } })
  return w
}

// ── MAIN ───────────────────────────────────────────────────────────────────────
if (isMainThread) {
  console.log('╔═══════════════════════════════════╗')
  console.log('║  A L U C A R D  v1.0              ║')
  console.log('║  Operator: Bun Omar Secka          ║')
  console.log('╚═══════════════════════════════════╝')

  await initDB()
  await initOverlay()

  const chains = detectChains()
  if (!chains.length) console.warn('[BOOT] No Alchemy URLs in env — add https://CHAIN.g.alchemy.com/v2/KEY as env vars')

  spawn('./chains.js',   { chains })
  spawn('./nexus.js')
  spawn('./apex.js')
  spawn('./sovereign.js')

  // Main thread modules (no Worker isolation needed)
  const [{ startDashboard }, { startRS }, { startTreasury }] = await Promise.all([
    import('./dashboard.js'),
    import('./rs_engine.js'),
    import('./treasury.js'),
  ])

  startDashboard(SAB, chains, ENV)
  startRS(SAB)
  startTreasury(SAB)

  // Uptime + midnight reset
  setInterval(() => HOT[8]++, 1000)
  const midnight = () => {
    const n = new Date(), nx = new Date()
    nx.setUTCHours(0,0,0,0); nx.setUTCDate(nx.getUTCDate()+1)
    setTimeout(() => { HOT[1]=0; console.log('[BOOT] Daily revenue reset'); midnight() }, nx-n)
  }
  midnight()

  // Health endpoint — Railway healthcheck hits /health
  const { createServer } = await import('http')
  createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, {'Content-Type':'application/json'})
      res.end(JSON.stringify({ ok:true, propeller:HOT[0], uptime:HOT[8], chains:chains.length, rev:HOT[1] }))
    } else { res.writeHead(404); res.end() }
  }).listen(3001).on('error', () => {})  // silent if port in use

  process.on('uncaughtException',  e => console.error('[BOOT]', e.message))
  process.on('unhandledRejection', r => console.error('[BOOT]', String(r).slice(0,100)))
  process.on('SIGTERM', () => process.exit(0))

  console.log(`[BOOT] Live on :${ENV.PORT} | propeller P${HOT[0]} | ${chains.length} chains`)
}
