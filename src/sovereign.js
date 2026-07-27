// src/sovereign.js — FINAL. Worker Thread. No dynamic imports. No Atomics.waitAsync.
// All exports available synchronously. Works on Railway free tier.
import { workerData }                   from 'worker_threads'
import { existsSync, writeFileSync,
         readFileSync, mkdirSync }       from 'fs'
import { fileURLToPath }                 from 'url'
import path                              from 'path'

const { SAB }    = workerData
const HOT        = new Float64Array(SAB)
const __dirname  = path.dirname(fileURLToPath(import.meta.url))

const DATA_DIR  = existsSync('/data') ? '/data' : (() => { mkdirSync('./data',{recursive:true}); return './data' })()
const SDAL_PATH = `${DATA_DIR}/sdal.json`

let SDAL = {
  propellerLevel:5, flashMultiplier:1.0,
  lastLearning:0, competitorModel:{}, gasHistory:{}
}
try { SDAL = { ...SDAL, ...JSON.parse(readFileSync(SDAL_PATH,'utf8')) } } catch {}
const saveSDAL = () => { try { writeFileSync(SDAL_PATH, JSON.stringify(SDAL)) } catch {} }

// ── 4 LAWS (enforced every governance cycle) ───────────────────────────────────
const LAWS = {
  1:'Capital protection. $1B/hr loss = halt.',
  2:'Hit propeller target exactly.',
  3:'Operator commands override all.',
  4:'Optimize continuously.',
}

// ── CHAT (called from dashboard via IPC message) ───────────────────────────────
// sovereign.js receives parentPort messages with { type:'chat', msg }
// and replies with { type:'chatReply', response }
import { parentPort } from 'worker_threads'

parentPort?.on('message', async msg => {
  if (msg?.type === 'chat') {
    const reply = processChat(msg.msg || '')
    parentPort.postMessage({ type:'chatReply', id:msg.id, response:reply })
  }
})

function processChat(msg) {
  const m = msg.toLowerCase().trim()
  if (m.match(/propeller[:\s]+(\d+\.?\d*)/)) {
    const lvl = parseFloat(m.match(/(\d+\.?\d*)/)[0])
    if (lvl >= 0 && lvl <= 50) { HOT[0]=lvl; SDAL.propellerLevel=lvl; saveSDAL(); return `✓ Propeller → P${lvl}` }
  }
  if (/\bhalt\b|\bstop\b/.test(m))   { HOT[0]=0;  return '⚠ Halted' }
  if (/\bresume\b|\bstart\b/.test(m)) { HOT[0]=SDAL.propellerLevel||5; return `✓ Resumed P${HOT[0]}` }
  if (/\bcrash\b/.test(m))            { HOT[0]=50; HOT[4]=100; return '🔴 CRASH MODE P50' }
  if (/\bstatus\b/.test(m)) return `P${HOT[0]} | $${(HOT[1]/1e12).toFixed(4)}T/day | Flash $${((HOT[2]+HOT[3])/1e9).toFixed(0)}B | Uptime ${Math.floor(HOT[8]/60)}min`
  if (/\blaws\b/.test(m)) return Object.entries(LAWS).map(([k,v])=>`LAW ${k}: ${v}`).join('\n')
  return `SOVEREIGN P${HOT[0]} | Revenue: $${(HOT[1]/1e12).toFixed(4)}T today | Commands: status, propeller N, halt, resume, crash, laws`
}

// ── LEARNING ───────────────────────────────────────────────────────────────────
const outcomes = []
function learnFromOutcomes() {
  if (outcomes.length < 10) return
  const batch  = outcomes.splice(0, 50)
  const avgErr = batch.reduce((s,o) => s + Math.abs((o.actual-o.predicted)/(Math.abs(o.predicted)||1)), 0) / batch.length
  if (avgErr > 0.05) SDAL.flashMultiplier = Math.max(0.7, SDAL.flashMultiplier*0.98)
  else if (avgErr < 0.02) SDAL.flashMultiplier = Math.min(1.5, SDAL.flashMultiplier*1.01)
  SDAL.lastLearning = Date.now()
  saveSDAL()
}

// ── DAILY TARGET ───────────────────────────────────────────────────────────────
function dailyTarget(lvl) {
  if (lvl<=0.1) return 1e6;  if (lvl<=1)  return 1e9
  if (lvl<=5)   return 5e10; if (lvl<=11) return 1.5e12
  if (lvl<=15)  return 3e12; if (lvl<=20) return 5e12
  if (lvl<=25)  return 7e12; return 8.7e15
}

// ── GOVERNANCE LOOP (60s) ──────────────────────────────────────────────────────
async function governLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 60_000))
    try {
      // LAW 1: emergency halt on excessive loss
      // (simplified: check if revenue went negative unexpectedly)
      if (HOT[1] < -1e9) { HOT[0]=0; console.error('[SOVEREIGN] LAW 1: Emergency halt') }

      // LAW 2: pace check
      const pct = (HOT[8]%86400)/86400
      const exp = dailyTarget(HOT[0]) * pct
      if (HOT[1] < exp*0.8) SDAL.flashMultiplier = Math.min(1.5, SDAL.flashMultiplier*1.02)
      else if (HOT[1] > exp*1.05) SDAL.flashMultiplier = Math.max(0.5, SDAL.flashMultiplier*0.98)

      learnFromOutcomes()

      // Hyperliquid funding rates for RS5 crash signal
      try {
        const r = await fetch('https://api.hyperliquid.xyz/info', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'metaAndAssetCtxs'}),
          signal:AbortSignal.timeout(5000)
        })
        if (r.ok) {
          const [,ctxs] = await r.json()
          const max = Math.max(...ctxs.slice(0,20).map(c => Math.abs(parseFloat(c.funding||0))))
          HOT[4] = Math.min(max*5000, 100)
        }
      } catch {}

      saveSDAL()
    } catch (e) {
      if (process.env.DEBUG) console.error('[SOVEREIGN]', e.message?.slice(0,50))
    }
  }
}

// ── MIDNIGHT LEARNING REVIEW ───────────────────────────────────────────────────
function scheduleReview() {
  const now=new Date(), nx=new Date()
  nx.setUTCHours(3,0,0,0); nx.setUTCDate(nx.getUTCDate()+1)
  setTimeout(() => { learnFromOutcomes(); scheduleReview() }, nx-now)
}

scheduleReview()
governLoop()
console.log('[SOVEREIGN] Online. 4 Laws active.')
