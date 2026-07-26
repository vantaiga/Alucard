// src/sovereign.js — REDRAFT: Worker Thread, no dynamic imports, no Atomics.waitAsync
// Pure polling, all imports static at top, works on Railway free tier
import { workerData }              from 'worker_threads'
import { existsSync, writeFileSync,
         readFileSync, mkdirSync }  from 'fs'
import { getConfig, setConfig }    from './db.js'

const { SAB } = workerData
const HOT     = new Float64Array(SAB)

// ── 4 LAWS ─────────────────────────────────────────────────────────────────────
const LAWS = Object.freeze({
  1: 'Capital protection. Risk Guardian veto absolute. $1B/hr loss = halt.',
  2: 'Hit propeller target exactly. Governor, not estimate.',
  3: 'Operator commands override all SOVEREIGN preferences.',
  4: 'Optimize continuously. Every outcome measured. Every param evolved.',
})

// ── SDAL PATH ─────────────────────────────────────────────────────────────────
const DATA_DIR  = existsSync('/data') ? '/data' : './data'
const SDAL_PATH = `${DATA_DIR}/sdal.json`
let SDAL = {}

function loadSDAL() {
  try { SDAL = JSON.parse(readFileSync(SDAL_PATH,'utf8')) } catch {
    SDAL = { propellerLevel:5, flashMultiplier:1.0, minProfit:5000, lastLearning:0, competitorModel:{}, gasHistory:{} }
    saveSDAL()
  }
}

function saveSDAL() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR,{recursive:true})
    writeFileSync(SDAL_PATH, JSON.stringify(SDAL,null,2))
  } catch {}
}

loadSDAL()

// ── CHAT COMMAND PROCESSOR ────────────────────────────────────────────────────
// Used by dashboard.js to process operator commands
const _chatHistory = []

export function chat(msg) {
  const m = msg.toLowerCase().trim()
  _chatHistory.push({ role:'user', msg, ts:Date.now() })
  let reply = ''

  if (m.match(/set propeller (\d+\.?\d*)/)) {
    const lvl = parseFloat(m.match(/set propeller (\d+\.?\d*)/)[1])
    if (lvl >= 0 && lvl <= 50) { HOT[0] = lvl; SDAL.propellerLevel = lvl; saveSDAL(); reply = `✓ Propeller set to ${lvl}` }
    else reply = 'Invalid level. Range: 0 to 50.'
  } else if (m.includes('halt') || m.includes('stop')) {
    HOT[0] = 0; reply = '⚠ System halted — propeller at 0'
  } else if (m.includes('resume') || m.includes('start')) {
    HOT[0] = SDAL.propellerLevel || 5; reply = `✓ Resumed at P${HOT[0]}`
  } else if (m.includes('crash') || m === 'p∞') {
    HOT[0] = 50; HOT[4] = 100; reply = '🔴 CRASH MODE ACTIVE — P50, all resources deployed'
  } else if (m.includes('status')) {
    reply = `P${HOT[0]} | Revenue: $${(HOT[1]/1e12).toFixed(4)}T | Flash: $${((HOT[2]+HOT[3])/1e9).toFixed(1)}B | Execs: ${HOT[7]} | Uptime: ${Math.floor(HOT[8]/60)}min`
  } else if (m.includes('laws')) {
    reply = Object.entries(LAWS).map(([k,v]) => `LAW ${k}: ${v}`).join('\n')
  } else {
    reply = `SOVEREIGN online. P${HOT[0]} active. Revenue today: $${(HOT[1]/1e12).toFixed(4)}T. Ask: status, set propeller N, halt, resume, crash, laws.`
  }

  _chatHistory.push({ role:'sovereign', msg:reply, ts:Date.now() })
  return reply
}

// ── LEARNING ENGINE ────────────────────────────────────────────────────────────
const _outcomes = []

export function recordOutcome(predicted, actual) {
  _outcomes.push({ predicted, actual, ts:Date.now() })
  if (_outcomes.length >= 50) _processLearning()
}

function _processLearning() {
  const batch  = _outcomes.splice(0, 50)
  const errors = batch.map(o => Math.abs((o.actual - o.predicted) / (Math.abs(o.predicted) || 1)))
  const avgErr = errors.reduce((s,e) => s+e, 0) / errors.length

  if (avgErr > 0.05)       SDAL.flashMultiplier = Math.max(0.7, SDAL.flashMultiplier * 0.98)
  else if (avgErr < 0.02)  SDAL.flashMultiplier = Math.min(1.5, SDAL.flashMultiplier * 1.01)

  SDAL.lastLearning = Date.now()
  saveSDAL()

  if (process.env.DEBUG) console.log(`[SOVEREIGN] Learning: avgErr=${(avgErr*100).toFixed(2)}% | multiplier=${SDAL.flashMultiplier.toFixed(3)}`)
}

// ── GOVERNANCE LOOP (60s interval) ────────────────────────────────────────────
async function governanceLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, 60000))
    try {
      // LAW 2: Check propeller target adherence
      const level  = HOT[0]
      const daily  = HOT[1]
      const uptime = HOT[8]
      if (uptime < 60) continue  // wait 60s before governing

      // Compute expected revenue at this point in the day
      const dayFraction    = (uptime % 86400) / 86400
      const dailyTarget    = _getTarget(level)
      const expectedSoFar  = dailyTarget * dayFraction

      if (daily < expectedSoFar * 0.8) {
        // Behind pace: boost flash multiplier slightly
        SDAL.flashMultiplier = Math.min(1.5, SDAL.flashMultiplier * 1.02)
        console.log(`[SOVEREIGN] Behind pace (${(daily/expectedSoFar*100).toFixed(0)}%) — boosting multiplier to ${SDAL.flashMultiplier.toFixed(3)}`)
      } else if (daily > expectedSoFar * 1.05) {
        // Ahead of pace: throttle (propeller is EXACT, not floor)
        SDAL.flashMultiplier = Math.max(0.5, SDAL.flashMultiplier * 0.98)
      }

      // Poll Hyperliquid funding rates for RS5
      try {
        const r = await fetch('https://api.hyperliquid.xyz/info', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'metaAndAssetCtxs'}), signal:AbortSignal.timeout(5000)
        })
        const [, ctxs] = await r.json()
        const maxRate   = Math.max(...ctxs.slice(0,20).map(c => Math.abs(parseFloat(c.funding||0))))
        HOT[4] = Math.min(maxRate * 5000, 100)  // normalize to crash signal 0-100
      } catch {}

      saveSDAL()
    } catch (e) {
      if (process.env.DEBUG) console.error('[SOVEREIGN] governance error:', e.message)
    }
  }
}

function _getTarget(level) {
  if (level <= 0.1)  return 1e6
  if (level <= 1)    return 1e9
  if (level <= 5)    return 5e10
  if (level <= 10)   return 1e12
  if (level <= 11)   return 1.5e12
  if (level <= 15)   return 3e12
  if (level <= 20)   return 5e12
  if (level <= 25)   return 7e12
  return 8.7e15  // P30
}

// ── OVERNIGHT REVIEW (3AM UTC) ─────────────────────────────────────────────────
function scheduleReview() {
  const now  = new Date()
  const next = new Date(); next.setUTCHours(3,0,0,0)
  if (next <= now) next.setUTCDate(next.getUTCDate()+1)
  setTimeout(() => {
    _processLearning()
    console.log('[SOVEREIGN] Overnight review complete')
    scheduleReview()
  }, next - now)
}

scheduleReview()
governanceLoop()
console.log('[SOVEREIGN] Online. 4 Laws active. AGI governance running.')
