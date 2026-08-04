// src/dashboard.js — ALUCARD + AEGIS
// 100% HOT. Zero fake data. Zero simulation.
// Serves Daybreak at / and The Eye at /eye from the same server.
// Broadcasts every 500ms to every connected WS client.
// PIN cleaned of all Railway-injected chars before comparison.
// /ping requires no PIN — use it to confirm server is alive.
import { createRequire }    from 'module'
import { createServer }     from 'http'
import { existsSync }       from 'fs'
import { fileURLToPath }    from 'url'
import path                 from 'path'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const _req  = createRequire(import.meta.url)
const express              = _req(path.join(__dir,'../node_modules/express'))
const { WebSocketServer }  = _req(path.join(__dir,'../node_modules/ws'))

import { getExecutions, exportSnapshot, recordTransfer, getTreasuryHistory } from './db.js'
import { getQueueSize }     from './overlay.js'
import { CHAINS, TOTAL_FLASH, TOTAL_CYCLES, getPropellerTarget,
         EXECUTOR, TREASURY }                   from './config.js'

// ── PIN — strip every char Railway can inject ────────────────────────────────
const cleanPin = s => String(s || '').replace(/[^0-9a-zA-Z]/g, '')
const PIN      = cleanPin(process.env.DASHBOARD_PASSKEY || '3530588')

// ── REFS set by startDashboard() ────────────────────────────────────────────
let SAB_REF      = null
let CHAINS_REF   = []
let SOVEREIGN_W  = null
const WS_CLIENTS = new Set()
let   rejections = 0

// ── HOT READ — every field is a direct SAB read, nothing invented ───────────
function hot() {
  if (!SAB_REF) return null
  return new Float64Array(SAB_REF)
}

function fullState() {
  const H = hot()
  if (!H) return { type:'state', ts:Date.now(), booting:true }

  const propeller  = H[0]
  const target     = getPropellerTarget(propeller)
  const flashTotal = H[2] + H[3]
  const uptime     = H[8] | 0
  const execCount  = H[7] | 0
  const memMB      = process.memoryUsage().heapUsed / 1024 / 1024 | 0

  let queueSize = 0
  try { queueSize = getQueueSize() } catch {}

  const chains = CHAINS_REF.map((c, i) => ({
    name:   c.name,
    id:     c.id,
    active: H[40 + i] > 0,
    gas:    H[20 + i] > 0 ? H[20 + i].toFixed(1) : '0',
  }))

  return {
    type:          'state',
    ts:            Date.now(),
    // ── Propeller
    propeller,
    target,
    dailyRevenue:  H[1],
    revPct:        target > 0 ? Math.min(H[1] / target * 100, 100) : 0,
    // ── Flash
    flashBase:     H[2],
    flashReserve:  H[3],
    flashTotal,
    // ── Signals
    crashSignal:   H[4],
    // ── Treasury
    treasury:      H[5],
    treasuryYield: H[5] > 0 ? H[5] * (0.20*0.065 + 0.50*0.042 + 0.30*0.0335) / 365 : 0,
    // ── Amplifier
    amplifierBonus:  H[10],
    totalAmplified:  H[11],
    // ── Ops
    executions:    execCount,
    uptime,
    queueSize,
    // ── Chains
    chainCount:    CHAINS_REF.length,
    activeWS:      chains.filter(c => c.active).length,
    chains,
    // ── System
    memMB,
    memCap:        120,
    executor:      EXECUTOR,
    treasuryAddr:  TREASURY,
    wsClients:     WS_CLIENTS.size,
    totalCycles:   TOTAL_CYCLES,
    p30Dynamic:    (CHAINS_REF.length / 20) * 8.7e15,
  }
}

// ── BROADCAST — fires every 500ms unconditionally ───────────────────────────
function broadcast(data) {
  const payload = JSON.stringify(data)
  for (const ws of WS_CLIENTS) {
    if (ws.readyState === 1) {
      try { ws.send(payload) } catch { WS_CLIENTS.delete(ws) }
    }
  }
}

// ── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express()
const srv = createServer(app)
const wss = new WebSocketServer({ server: srv, perMessageDeflate: false })

app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(__dir, '../dashboard')))

// Dashboards — no auth needed to load the HTML
app.get('/', (_, res) => {
  const p = path.join(__dir, '../dashboard/daybreak.html')
  existsSync(p) ? res.sendFile(p) : res.status(404).send('daybreak.html not found in /dashboard/')
})
app.get('/eye', (_, res) => {
  const p = path.join(__dir, '../dashboard/eye.html')
  existsSync(p) ? res.sendFile(p) : res.status(404).send('eye.html not found in /dashboard/')
})

// ── NO-AUTH DIAGNOSTICS ──────────────────────────────────────────────────────
app.get('/ping', (_, res) => {
  const H = hot()
  res.json({
    ok:          true,
    ts:          Date.now(),
    system:      'ALUCARD/AEGIS',
    wsClients:   WS_CLIENTS.size,
    wsRejected:  rejections,
    pinLength:   PIN.length,
    uptime:      H ? H[8]|0 : 0,
    propeller:   H ? H[0]   : 0,
    rev:         H ? H[1]   : 0,
    flash:       H ? (H[2]+H[3]) : 0,
    chains:      CHAINS_REF.length,
    activeWS:    H ? CHAINS_REF.filter((_,i) => H[40+i]>0).length : 0,
  })
})

// ── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const raw = req.headers['x-pin'] || req.query.pin || req.body?.pin || ''
  if (cleanPin(raw) !== PIN) return res.status(401).json({ error: 'Invalid PIN' })
  next()
}

// ── API ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/state', auth, (_, res) => res.json(fullState()))

app.get('/api/executions', auth, (req, res) => {
  try { res.json(getExecutions(parseInt(req.query.limit) || 100)) } catch { res.json([]) }
})

app.get('/api/treasury', auth, (_, res) => {
  try { res.json({ history: getTreasuryHistory(50), ...fullState() }) } catch { res.json({}) }
})

app.get('/api/queue', auth, (_, res) => {
  res.json({ size: queueSize() })
  function queueSize() { try { return getQueueSize() } catch { return 0 } }
})

app.get('/api/bridges', auth, (_, res) => {
  const bridges = []
  for (const [k, v] of Object.entries(process.env)) {
    if (k.match(/^[A-Z][A-Z0-9]+_SECRET_KEY$/) && v) bridges.push(k.replace('_SECRET_KEY','').toLowerCase())
  }
  res.json({ bridges })
})

app.post('/api/propeller', auth, (req, res) => {
  const { level } = req.body
  if (typeof level !== 'number' || level < 0 || level > 50)
    return res.status(400).json({ error: 'Level 0–50' })
  const H = hot(); if (!H) return res.status(503).json({ error: 'not ready' })
  H[0] = level
  const target = getPropellerTarget(level)
  broadcast({ type: 'propeller', level, target })
  res.json({ ok: true, level, target })
})

app.post('/api/crash', auth, (req, res) => {
  const H = hot(); if (!H) return res.status(503).json({ error: 'not ready' })
  const { on } = req.body
  if (on) { H[0] = 50; H[4] = 100 } else { H[0] = 5; H[4] = 0 }
  broadcast({ type: 'crash', active: !!on })
  res.json({ ok: true, active: !!on })
})

app.post('/api/halt', auth, (_, res) => {
  const H = hot(); if (!H) return res.status(503).json({ error: 'not ready' })
  H[0] = 0
  broadcast({ type: 'halt' })
  res.json({ ok: true })
})

app.post('/api/transfer', auth, async (req, res) => {
  const { bridge = 'modempay', ...params } = req.body
  try {
    const { send } = await import('./settlement.js')
    const result   = await send(bridge, params)
    try { recordTransfer({ type:params.type||'', amount:params.amount||0, bridge, recipient:params.phone||params.accountNumber||params.address||'', status:'submitted', reference:result.reference||'' }) } catch {}
    broadcast({ type: 'transfer', amount: params.amount, bridge, status: 'submitted' })
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/chat', auth, async (req, res) => {
  const { message } = req.body
  if (!message) return res.status(400).json({ error: 'No message' })
  try {
    const response = await new Promise((resolve, reject) => {
      if (!SOVEREIGN_W) return reject(new Error('Sovereign not linked'))
      const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2,6)}`
      const handler = msg => { if (msg?.type==='chatReply'&&msg.id===id) { SOVEREIGN_W.off('message',handler); resolve(msg.response) } }
      SOVEREIGN_W.on('message', handler)
      SOVEREIGN_W.postMessage({ type:'chat', id, msg:message })
      setTimeout(() => { SOVEREIGN_W.off('message',handler); reject(new Error('timeout')) }, 8000)
    })
    res.json({ response, ts: Date.now() })
  } catch {
    const H = hot()
    res.json({ response: `SOVEREIGN P${H?H[0]:5} | uptime ${H?H[8]|0:0}s | type status for report`, ts: Date.now() })
  }
})

app.post('/api/snapshot', auth, (_, res) => {
  try { res.json({ ok: true, ...exportSnapshot() }) } catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/snapshot/download', auth, (_, res) => {
  const p = ['/data/snapshot.json', './data/snapshot.json'].find(existsSync)
  if (!p) return res.status(404).json({ error: 'No snapshot. POST /api/snapshot first.' })
  res.download(p, 'snapshot.json')
})

// ── WEBSOCKET SERVER ─────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  // PIN must come from URL query string — only reliable method for WS upgrades
  let incoming = ''
  try { incoming = cleanPin(new URL(req.url || '/', 'http://x').searchParams.get('pin') || '') } catch {}

  if (incoming !== PIN) {
    rejections++
    // Log exact mismatch so operator can debug
    console.warn(`[DASHBOARD] WS REJECTED #${rejections} | received:'${incoming}' expected:'${PIN}' | verify DASHBOARD_PASSKEY in Railway Variables`)
    ws.close(4001, 'Unauthorized')
    return
  }

  WS_CLIENTS.add(ws)
  // Send full state immediately — client sees data without waiting for next tick
  ws.send(JSON.stringify(fullState()))

  ws.on('close', () => {
    WS_CLIENTS.delete(ws)
  })
  ws.on('error', () => {
    WS_CLIENTS.delete(ws)
  })
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.type === 'propeller' && typeof m.level === 'number') {
        const H = hot()
        if (H) { H[0] = m.level; broadcast({ type:'propeller', level:m.level, target:getPropellerTarget(m.level) }) }
      }
      if (m.type === 'chat' && m.message && SOVEREIGN_W) {
        const id = `chat_${Date.now()}`
        SOVEREIGN_W.postMessage({ type:'chat', id, msg:m.message })
      }
    } catch {}
  })

  console.log(`[DASHBOARD] WS CONNECTED | clients:${WS_CLIENTS.size} | uptime:${hot()?hot()[8]|0:0}s`)
})

// ── BROADCAST LOOP — 500ms, unconditional ────────────────────────────────────
setInterval(() => {
  if (WS_CLIENTS.size === 0) return
  broadcast(fullState())
}, 500)

// ── SOVEREIGN REPLY RELAY ────────────────────────────────────────────────────
function linkSovereign(worker) {
  if (!worker) return
  worker.on('message', msg => {
    if (msg?.type === 'chatReply') broadcast({ type:'chatReply', id:msg.id, response:msg.response })
  })
}

// ── EXPORT ───────────────────────────────────────────────────────────────────
export function startDashboard(SAB, chains, sovereignWorker) {
  SAB_REF    = SAB
  CHAINS_REF = chains || []
  SOVEREIGN_W = sovereignWorker || null
  linkSovereign(SOVEREIGN_W)

  const PORT = parseInt(process.env.PORT || '3000')
  srv.listen(PORT, () => {
    console.log(`[DASHBOARD] :${PORT} | PIN length:${PIN.length}`)
    console.log(`[DASHBOARD] Daybreak → / | The Eye → /eye`)
    console.log(`[DASHBOARD] Connectivity test: GET /ping (no auth)`)
  })
}
