// ═══════════════════════════════════════════════════════════════
// src/index.js — Boot. SAB. Workers. 3 env vars only.
// All chain/wallet config lives in config.js
// ═══════════════════════════════════════════════════════════════
import { Worker, isMainThread }          from 'worker_threads'
import { fileURLToPath }                  from 'url'
import { createServer }                   from 'http'
import path                               from 'path'
import { CHAINS, TOTAL_FLASH, TOTAL_CYCLES, MEMORY_MB, EXECUTOR, TREASURY } from './config.js'
import { initDB }                         from './db.js'
import { initOverlay }                    from './overlay.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── 3 ENV VARS — warn only, never crash ───────────────────────────────────────
if (!process.env.MODEMPAY_SECRET_KEY) console.warn('[BOOT] MODEMPAY_SECRET_KEY not set — settlement in test mode')
if (!process.env.DASHBOARD_PASSKEY)   console.warn('[BOOT] DASHBOARD_PASSKEY not set — using default 3530588')

const ENV = {
  PORT:     parseInt(process.env.PORT||'3000'),
  PIN:      process.env.DASHBOARD_PASSKEY||'3530588',
  MPKEY:    process.env.MODEMPAY_SECRET_KEY||'',
}

// ── MASTER SAB (4096 bytes) ────────────────────────────────────────────────────
// Float64 layout (offset × 8 bytes):
//  [0]  propeller      [1]  daily_rev       [2]  flash_base    [3]  flash_reserve
//  [4]  crash_signal   [5]  treasury_bal    [6]  queue_size    [7]  exec_count
//  [8]  uptime_sec     [9]  v7_active       [10] amplifier_rev [11] total_rev_all
//  [20-39] gas_gwei/chain   [40-59] chain_active  [60-79] competition/chain
// Int32 signal slots at SAB bytes 4080–4095 (outside Float64 area):
//  4080: chains→nexus write head
//  4084: nexus→apex write head
//  4088: control (halt/crash flags)
// Ring buffers:
//  bytes 1024–2047: chains→nexus (64 slots × 16 bytes: [usd:f64][chainId:f64])
//  bytes 2048–3071: nexus→apex   (64 slots × 16 bytes: [flash:f64][profit:f64])

export const SAB      = new SharedArrayBuffer(4096)
export const HOT      = new Float64Array(SAB)
export const SIG_C2N  = new Int32Array(SAB, 4080)   // chains→nexus
export const SIG_N2A  = new Int32Array(SAB, 4084)   // nexus→apex
export const SIG_CTRL = new Int32Array(SAB, 4088)   // control

// Defaults
HOT[0] = 5                // P5 propeller
HOT[2] = TOTAL_FLASH      // $45.59B base flash

// ── MEMORY GUARDIAN — hard ceiling, never exceeded ────────────────────────────
// Runs every 5 seconds. Enforces MEMORY_MB ceiling unconditionally.
const memGuard = () => {
  const mb = process.memoryUsage().heapUsed / 1024 / 1024
  HOT[6] = mb  // store current MB in SAB slot 6 (reused for mem monitoring)
  if (mb > MEMORY_MB * 0.85) {
    // 85% threshold: aggressive GC
    if (global.gc) global.gc()
  }
  if (mb > MEMORY_MB * 0.95) {
    // 95% threshold: emit signal to workers to flush/clear buffers
    Atomics.store(SIG_CTRL, 0, 1)   // signal: memory pressure
    if (global.gc) global.gc()
    console.warn(`[MEM] ${mb.toFixed(0)}MB — pressure signal sent`)
  }
}
setInterval(memGuard, 5000)

// ── WORKER SPAWNER ─────────────────────────────────────────────────────────────
function spawn(file, extra={}) {
  const url = new URL(file, import.meta.url)
  const w   = new Worker(url, { workerData:{ SAB, ...extra } })
  const tag = path.basename(file,'.js').toUpperCase()
  w.on('error',   e => console.error(`[${tag}]`, e.message?.slice(0,80)))
  w.on('exit',    c => { if(c!==0) setTimeout(()=>spawn(file,extra), 2000) })
  return w
}

// ── BOOT ───────────────────────────────────────────────────────────────────────
if (isMainThread) {
  console.log('╔══════════════════════════════════════════╗')
  console.log('║   A L U C A R D  v2.0  — Production      ║')
  console.log(`║   Executor:  ${EXECUTOR.slice(0,20)}...  ║`)
  console.log(`║   Treasury:  ${TREASURY.slice(0,20)}...  ║`)
  console.log(`║   Chains:    ${CHAINS.length} | Flash: $${(TOTAL_FLASH/1e9).toFixed(1)}B      ║`)
  console.log(`║   Cycles:    ${(TOTAL_CYCLES/1e6).toFixed(2)}M/day               ║`)
  console.log('╚══════════════════════════════════════════╝')

  await initDB()
  await initOverlay()

  // Spawn Worker threads
  spawn('./chains.js',    { chains: CHAINS })
  spawn('./nexus.js')
  spawn('./apex.js')
  spawn('./sovereign.js')

  // Main-thread modules
  const [{ startDashboard }, { startRS }, { startTreasury }] =
    await Promise.all([import('./dashboard.js'), import('./rs_engine.js'), import('./treasury.js')])

  startDashboard(SAB, CHAINS, ENV)
  startRS(SAB)
  startTreasury(SAB, ENV)

  // Health endpoint
  createServer((req,res) => {
    if (req.url!=='/health') { res.writeHead(404); return res.end() }
    res.writeHead(200,{'Content-Type':'application/json'})
    res.end(JSON.stringify({ ok:true, p:HOT[0], rev:HOT[1], chains:CHAINS.length, mb:process.memoryUsage().heapUsed/1024/1024|0, uptime:HOT[8]|0 }))
  }).listen(3001).on('error',()=>{})

  // Uptime + midnight reset
  setInterval(()=>HOT[8]++, 1000)
  const sched=()=>{ const n=new Date(),nx=new Date(); nx.setUTCHours(0,0,0,0); nx.setUTCDate(nx.getUTCDate()+1); setTimeout(()=>{HOT[1]=0;console.log('[BOOT] Daily rev reset');sched()},nx-n) }
  sched()

  process.on('uncaughtException',  e=>console.error('[BOOT]',e.message?.slice(0,100)))
  process.on('unhandledRejection', r=>console.error('[BOOT]',String(r).slice(0,100)))
  process.on('SIGTERM', ()=>process.exit(0))

  console.log(`[BOOT] Operational — :${ENV.PORT} | P${HOT[0]} | ${CHAINS.length} chains`)
}
