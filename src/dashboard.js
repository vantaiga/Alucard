// ═══════════════════════════════════════════════════════════════
// src/dashboard.js — ALUCARD + AEGIS
// Inspired by Vanguard: no PIN, no auth, immediate state on connect
// Heartbeat every 15s, 2s tick, _started guard, never throws
// ═══════════════════════════════════════════════════════════════
import express             from 'express'
import { createServer }    from 'http'
import { WebSocketServer } from 'ws'
import { existsSync }      from 'fs'
import { fileURLToPath }   from 'url'
import { join, dirname }   from 'path'

import {
  getDB, getExecutions, exportSnapshot,
  recordTransfer, getTreasuryHistory,
} from './db.js'
import { getQueueSize }   from './overlay.js'
import {
  CHAINS, TOTAL_FLASH, TOTAL_CYCLES,
  getPropellerTarget, EXECUTOR, TREASURY,
} from './config.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const PORT  = parseInt(process.env.PORT || '3000')

// ── SERVER SINGLETON — created at module load, never recreated ────────────────
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })

app.use(express.json({ limit: '2mb' }))
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  next()
})
app.options('*', (_, res) => res.sendStatus(200))

// ── SAB REFERENCE — set once by startDashboard ────────────────────────────────
let SAB_REF     = null
let CHAINS_REF  = []

// ── STATE BUILDER — never throws, always returns something ─────────────────────
let _lastGoodState    = null
let _stateBuilds      = 0
let _stateErrors      = 0

function buildState() {
  _stateBuilds++
  try {
    if (!SAB_REF) return { type:'state', ts:Date.now(), booting:true, uptime:0, memMB:0, chainCount:0, activeWS:0, chains:[] }

    const HOT = new Float64Array(SAB_REF)

    let queueSize = 0
    try { queueSize = getQueueSize() } catch {}

    let recentExecs = []
    try { recentExecs = getExecutions(50) } catch {}

    const uptime    = HOT[8]  | 0
    const propeller = HOT[0]
    const target    = getPropellerTarget(propeller)
    const dailyRev  = HOT[1]
    const flash     = HOT[2] + HOT[3]
    const activeWS  = CHAINS_REF.filter((_, i) => HOT[40 + i] > 0).length

    const state = {
      type:        'state',
      ts:          Date.now(),
      // ── PROPELLER ────────────────────────────────────────────────
      propeller,
      target,
      dailyRevenue: dailyRev,
      revPct:       target > 0 ? Math.min(dailyRev / target * 100, 100) : 0,
      // ── FLASH ───────────────────────────────────────────────────
      flashBase:    HOT[2],
      flashReserve: HOT[3],
      flashTotal:   flash,
      // ── AMPLIFIER ────────────────────────────────────────────────
      amplifierBonus:  HOT[10],
      totalAmplified:  HOT[11],
      // ── SIGNALS ──────────────────────────────────────────────────
      crashSignal: HOT[4],
      v7Active:    HOT[9] > 0,
      // ── TREASURY ─────────────────────────────────────────────────
      treasury:    HOT[5],
      // ── OPS ──────────────────────────────────────────────────────
      executions:  HOT[7] | 0,
      uptime,
      // ── CHAINS ───────────────────────────────────────────────────
      chainCount:  CHAINS_REF.length,
      activeWS,
      chains: CHAINS_REF.map((c, i) => ({
        name:   c.name,
        id:     c.id,
        active: HOT[40 + i] > 0,
        gas:    HOT[20 + i] > 0 ? HOT[20 + i].toFixed(1) : '—',
      })),
      // ── SYSTEM ───────────────────────────────────────────────────
      memMB:    process.memoryUsage().heapUsed / 1024 / 1024 | 0,
      memCap:   120,
      queueSize,
      // ── IDENTITY ─────────────────────────────────────────────────
      executor:      EXECUTOR,
      treasury_addr: TREASURY,
      totalCycles:   TOTAL_CYCLES,
      p30Dynamic:    (CHAINS_REF.length / 20) * 8.7e15,
      // ── META ─────────────────────────────────────────────────────
      stateBuilds:  _stateBuilds,
      wsClients:    _clients.size,
      recentExecs,
    }

    _lastGoodState = state
    return state
  } catch (e) {
    _stateErrors++
    if (_lastGoodState) return _lastGoodState
    return {
      type:'state', ts:Date.now(), error:e.message?.slice(0,100),
      uptime:0, memMB:0, chainCount:0, activeWS:0, chains:[],
    }
  }
}

// ── WEBSOCKET — heartbeat + immediate state on connect ────────────────────────
const _clients         = new Set()
let   _lastTickPayload = null
let   _tickCount       = 0

wss.on('connection', ws => {
  _clients.add(ws)
  ws.isAlive = true
  ws.on('pong',  () => { ws.isAlive = true })
  ws.on('close', () => _clients.delete(ws))
  ws.on('error', () => _clients.delete(ws))

  // Send immediately — no waiting
  const payload = _lastTickPayload || JSON.stringify({ type:'state', ...buildState() })
  try { ws.send(payload) } catch {}

  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.type === 'propeller' && typeof m.level === 'number') {
        const HOT = new Float64Array(SAB_REF)
        HOT[0] = Math.max(0, Math.min(50, m.level))
        broadcast({ type:'propeller', level:HOT[0], target:getPropellerTarget(HOT[0]) })
      }
    } catch {}
  })
})

// Heartbeat — kills dead connections before they pile up
const _heartbeat = setInterval(() => {
  for (const ws of _clients) {
    if (!ws.isAlive) { ws.terminate(); _clients.delete(ws); continue }
    ws.isAlive = false
    try { ws.ping() } catch { ws.terminate(); _clients.delete(ws) }
  }
}, 15000)

// 2-second state tick to all clients
const _ticker = setInterval(() => {
  if (!_clients.size) return
  try {
    _tickCount++
    const s = buildState()
    _lastTickPayload = JSON.stringify({ type:'state', tick:_tickCount, ...s })
    for (const ws of _clients) {
      try { if (ws.readyState === 1) ws.send(_lastTickPayload) }
      catch { ws.terminate(); _clients.delete(ws) }
    }
  } catch {}
}, 2000)

function broadcast(d) {
  if (!_clients.size) return
  const p = JSON.stringify(d)
  for (const ws of _clients) {
    try { if (ws.readyState === 1) ws.send(p) } catch {}
  }
}

// ── STATIC + PAGES ────────────────────────────────────────────────────────────
const DASH_DIR = join(__dir, '../dashboard')

app.get('/', (_, res) => {
  const f = join(DASH_DIR, 'daybreak.html')
  existsSync(f) ? res.sendFile(f) : res.status(404).send('daybreak.html missing from /dashboard/')
})
app.get('/eye', (_, res) => {
  const f = join(DASH_DIR, 'eye.html')
  existsSync(f) ? res.sendFile(f) : res.status(404).send('eye.html missing from /dashboard/')
})
app.use(express.static(DASH_DIR))

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/state',   (_, res) => { try { res.json(buildState()) } catch (e) { res.status(500).json({ error:e.message }) } })
app.get('/api/health',  (_, res) => res.json({ ok:true, uptime:SAB_REF?new Float64Array(SAB_REF)[8]|0:0, clients:_clients.size, ticks:_tickCount, chains:CHAINS_REF.length }))
app.get('/ping',        (_, res) => res.json({ ok:true, system:'ALUCARD/AEGIS', ts:Date.now() }))

app.get('/api/executions', (req, res) => {
  try { res.json(getExecutions(parseInt(req.query.limit) || 100)) } catch { res.json([]) }
})
app.get('/api/treasury', (_, res) => {
  try { res.json({ history:getTreasuryHistory(50), balance:SAB_REF?new Float64Array(SAB_REF)[5]:0 }) } catch { res.json({}) }
})
app.get('/api/queue', (_, res) => res.json({ size:getQueueSize() }))

app.post('/api/propeller', (req, res) => {
  if (!SAB_REF) return res.status(503).json({ error:'not ready' })
  const { level } = req.body
  if (typeof level !== 'number' || level < 0 || level > 50) return res.status(400).json({ error:'Level 0-50' })
  const HOT = new Float64Array(SAB_REF)
  HOT[0] = level
  broadcast({ type:'propeller', level, target:getPropellerTarget(level) })
  res.json({ ok:true, level, target:getPropellerTarget(level) })
})

app.post('/api/command', (req, res) => {
  if (!SAB_REF) return res.status(503).json({ error:'not ready' })
  const HOT = new Float64Array(SAB_REF)
  const { command } = req.body
  if (command === 'halt')   HOT[0] = 0
  if (command === 'crash')  { HOT[0] = 50; HOT[4] = 100 }
  if (command === 'resume') HOT[0] = 5
  broadcast({ type:'command', command })
  res.json({ ok:true, command })
})

app.post('/api/transfer', async (req, res) => {
  try {
    const { send } = await import('./settlement.js')
    const result = await send(req.body.bridge || 'modempay', req.body)
    try { recordTransfer({ type:req.body.type||'transfer', amount:req.body.amount||0, bridge:req.body.bridge||'modempay', recipient:req.body.phone||req.body.accountNumber||req.body.address||'', status:'submitted', reference:result.reference||'' }) } catch {}
    res.json(result)
  } catch (e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/snapshot', (_, res) => {
  try { res.json({ ok:true, ...exportSnapshot() }) } catch (e) { res.status(500).json({ error:e.message }) }
})
app.get('/api/snapshot/download', (_, res) => {
  const p = ['/data/snapshot.json', './data/snapshot.json'].find(existsSync)
  if (!p) return res.status(404).json({ error:'POST /api/snapshot first' })
  res.download(p, 'snapshot.json')
})

// ── START — _started guard prevents double-bind ───────────────────────────────
let _started = false

export function startDashboard(SAB, chains) {
  SAB_REF     = SAB
  CHAINS_REF  = chains || []
  if (_started) return
  _started = true

  const tryBind = (port) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`[DASHBOARD] :${port} | Daybreak / | The Eye /eye`)
      console.log(`[DASHBOARD] WS ready — heartbeat 15s | tick 2s`)
    })
    server.on('error', e => {
      if (e.code === 'EADDRINUSE') {
        server.removeAllListeners('error')
        setTimeout(() => tryBind(port + 1), 500)
      } else {
        console.error('[DASHBOARD]', e.message)
      }
    })
  }
  tryBind(PORT)
}

process.on('exit', () => { clearInterval(_heartbeat); clearInterval(_ticker) })
