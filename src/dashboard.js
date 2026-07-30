// src/dashboard.js
// Super file. Broadcasts every byte of system state.
// Fixed: WS PIN from URL query (not headers). Fixed: absolute imports.
// Fixed: SAB polling sends live data even when values are updating.
// Serves both Daybreak (Alucard) and The Eye (Aegis) from /dashboard/

import { createRequire }    from 'module'
import { fileURLToPath }    from 'url'
import { createServer }     from 'http'
import { readFileSync, existsSync } from 'fs'
import path                 from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require   = createRequire(import.meta.url)

// Absolute require — resolves ws and express from project node_modules
// regardless of whether we are main thread or imported module
const express   = require(path.join(__dirname, '../node_modules/express'))
const { WebSocketServer } = require(path.join(__dirname, '../node_modules/ws'))

import { getDB, getExecutions, exportSnapshot,
         recordTransfer, getTreasuryHistory, getConfig, setConfig } from './db.js'
import { getQueueSize }  from './overlay.js'
import { CHAINS, TOTAL_FLASH, TOTAL_CYCLES,
         getPropellerTarget, EXECUTOR, TREASURY } from './config.js'

// ── REFS (set by startDashboard) ──────────────────────────────────────────────
let SAB_REF     = null
let ENV_REF     = { PORT:3000, PIN:'3530588', MPKEY:'' }
let SOVEREIGN_W = null   // sovereign worker ref for chat forwarding
let chatPending = new Map()   // id -> resolve

// ── EXPRESS + HTTP SERVER ──────────────────────────────────────────────────────
const app = express()
app.use(express.json({ limit:'1mb' }))

// Static: serve /dashboard/ folder (daybreak.html, eye.html, assets)
app.use(express.static(path.join(__dirname, '../dashboard')))

// Root → daybreak (default system)
app.get('/', (_, res) => {
  const p = path.join(__dirname, '../dashboard/daybreak.html')
  existsSync(p) ? res.sendFile(p) : res.send('Deploy daybreak.html to /dashboard/')
})
// Aegis dashboard
app.get('/eye', (_, res) => {
  const p = path.join(__dirname, '../dashboard/eye.html')
  existsSync(p) ? res.sendFile(p) : res.send('Deploy eye.html to /dashboard/')
})

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const pin = req.headers['x-pin'] || req.query.pin || req.body?.pin
  if (String(pin) !== String(ENV_REF.PIN)) return res.status(401).json({ error:'Invalid PIN' })
  next()
}

// ── FULL STATE SNAPSHOT ───────────────────────────────────────────────────────
// This is what every WS client receives every 500ms.
// Reads directly from SAB — no async, no network, pure memory.
function getFullState() {
  if (!SAB_REF) return { type:'state', error:'SAB not initialized' }
  const HOT      = new Float64Array(SAB_REF)
  const chainCount = CHAINS.length
  const p30      = (chainCount / 20) * 8.7e15

  // Per-chain status from SAB
  const chains = CHAINS.map((c, i) => ({
    name:     c.name,
    id:       c.id,
    native:   c.native,
    blocks:   c.blocks,
    flashB:   c.flashB,
    active:   HOT[40 + i] > 0,
    gas:      HOT[20 + i] ? HOT[20 + i].toFixed(2) : '0',
  }))

  const activeWS  = chains.filter(c => c.active).length
  const flashTotal = HOT[2] + HOT[3]
  const level      = HOT[0]
  const dailyRev   = HOT[1]
  const target     = getPropellerTarget(level)
  const treasury   = HOT[5]

  // DB values (sync reads from sql.js — instant)
  let queueSize = 0, execCount = 0, dbOk = false
  try {
    queueSize = getQueueSize()
    const db  = getDB()
    if (db) {
      const r = db.exec('SELECT COUNT(*) FROM executions')
      execCount = r[0]?.values[0]?.[0] || 0
      dbOk = true
    }
  } catch {}

  return {
    type:           'state',
    ts:             Date.now(),
    // Propeller
    propeller:      level,
    propellerLabel: level <= 1 ? `SSP${Math.round(level*10)}` : level <= 10 ? `SP${Math.round(level)}` : `P${Math.round(level)}`,
    target,
    dailyRevenue:   dailyRev,
    revPct:         target > 0 ? Math.min(dailyRev / target * 100, 100) : 0,
    // Flash
    flashBase:      HOT[2],
    flashReserve:   HOT[3],
    flashTotal,
    // Signals
    crashSignal:    HOT[4],
    // Treasury
    treasury,
    treasuryYieldDay: treasury > 0
      ? treasury * (0.20 * 0.065 + 0.50 * 0.042 + 0.30 * 0.0335) / 365
      : 0,
    // Amplifier
    amplifierBonus: HOT[10],
    totalAmplified: HOT[11],
    // Throughput
    totalCycles:    TOTAL_CYCLES,
    effectiveCycles:TOTAL_CYCLES * 4.17,
    throughput:     flashTotal * TOTAL_CYCLES * 4.17 * 0.00045,
    // Ops
    executions:     HOT[7],
    dbExecTotal:    execCount,
    uptime:         HOT[8],
    memMB:          process.memoryUsage().heapUsed / 1024 / 1024,
    memCap:         120,
    v7Active:       HOT[9] > 0,
    // Chains
    chainCount,
    chains,
    activeWS,
    p30Dynamic:     p30,
    // System
    executor:       EXECUTOR,
    treasury_addr:  TREASURY,
    dbOk,
    queueSize,
    // Derived
    multiplier:     205,
    extractionRate: 0.00045,
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  const HOT = SAB_REF ? new Float64Array(SAB_REF) : null
  res.json({
    ok:      true,
    uptime:  HOT ? HOT[8] | 0 : 0,
    propeller: HOT ? HOT[0] : 0,
    rev:     HOT ? HOT[1] : 0,
    chains:  CHAINS.length,
    mb:      process.memoryUsage().heapUsed / 1024 / 1024 | 0,
  })
})

// Full state (same as WS push, for initial load)
app.get('/api/state', auth, (_, res) => res.json(getFullState()))

// Propeller control
app.post('/api/propeller', auth, (req, res) => {
  const { level } = req.body
  if (typeof level !== 'number' || level < 0 || level > 50)
    return res.status(400).json({ error:'Level 0–50' })
  if (!SAB_REF) return res.status(503).json({ error:'SAB not ready' })
  const HOT = new Float64Array(SAB_REF)
  HOT[0] = level
  try { setConfig('propeller_level', level) } catch {}
  broadcast({ type:'propeller', level, target:getPropellerTarget(level) })
  res.json({ ok:true, level, target:getPropellerTarget(level) })
})

// Crash mode
app.post('/api/crash', auth, (req, res) => {
  if (!SAB_REF) return res.status(503).json({ error:'SAB not ready' })
  const { on } = req.body
  const HOT = new Float64Array(SAB_REF)
  if (on) { HOT[0] = 50; HOT[4] = 100 }
  else    { HOT[0] = parseFloat(getConfig('propeller_level') || '5'); HOT[4] = 0 }
  broadcast({ type:'crash', active:!!on, propeller:HOT[0] })
  res.json({ ok:true, active:!!on })
})

// Halt / resume
app.post('/api/command', auth, (req, res) => {
  if (!SAB_REF) return res.status(503).json({ error:'SAB not ready' })
  const { command } = req.body
  const HOT = new Float64Array(SAB_REF)
  if (command === 'halt')   { HOT[0] = 0;  broadcast({ type:'command', command:'halt' }) }
  if (command === 'resume') { HOT[0] = parseFloat(getConfig('propeller_level') || '5'); broadcast({ type:'command', command:'resume' }) }
  res.json({ ok:true, command })
})

// Executions log
app.get('/api/executions', auth, (req, res) => {
  try { res.json(getExecutions(parseInt(req.query.limit) || 100)) }
  catch { res.json([]) }
})

// Treasury history
app.get('/api/treasury', auth, (_, res) => {
  try {
    const HOT     = SAB_REF ? new Float64Array(SAB_REF) : new Float64Array(1)
    const balance = HOT[5] || 0
    res.json({
      balance,
      reserve:  HOT[3] || 0,
      yieldDay: balance * (0.20*0.065 + 0.50*0.042 + 0.30*0.0335) / 365,
      history:  getTreasuryHistory(50),
      wallet:   TREASURY,
    })
  } catch { res.json({ balance:0, history:[] }) }
})

// Queue size
app.get('/api/queue', auth, (_, res) => res.json({ size: getQueueSize() }))

// Snapshot export
app.post('/api/snapshot', auth, (_, res) => {
  try { res.json({ ok:true, ...exportSnapshot() }) }
  catch (e) { res.status(500).json({ error:e.message }) }
})
app.get('/api/snapshot/download', auth, (_, res) => {
  const candidates = ['/data/snapshot.json', './data/snapshot.json']
  const p = candidates.find(existsSync)
  if (!p) return res.status(404).json({ error:'No snapshot. POST /api/snapshot first.' })
  res.download(p, 'snapshot.json')
})

// ── SETTLEMENT API (bridge-agnostic) ─────────────────────────────────────────
const BRIDGES = {}
for (const [k, v] of Object.entries(process.env)) {
  const m = k.match(/^([A-Z][A-Z0-9]+)_SECRET_KEY$/)
  if (m && v) BRIDGES[m[1].toLowerCase()] = { key:v, name:m[1] }
}

app.get('/api/bridges', auth, (_, res) => res.json({
  bridges: Object.keys(BRIDGES),
  modes:   Object.fromEntries(Object.entries(BRIDGES).map(([n,b]) => [n, b.key.startsWith('sk_live_')?'LIVE':'TEST']))
}))

app.get('/api/balance/:bridge', auth, async (req, res) => {
  const b = BRIDGES[req.params.bridge]
  if (!b) return res.status(404).json({ error:'Bridge not found' })
  try {
    const r = await fetch('https://api.modempay.com/v1/balances',
      { headers:{ Authorization:`Bearer ${b.key}` }, signal:AbortSignal.timeout(10000) })
    res.json(await r.json())
  } catch (e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/transfer', auth, async (req, res) => {
  const { bridge='modempay', type, amount, phone, accountNumber,
          accountName, swiftCode, address, chain, network } = req.body
  const b = BRIDGES[bridge.toLowerCase()]
  if (!b) return res.status(400).json({ error:`Bridge '${bridge}' not configured` })
  if (!amount || amount <= 0) return res.status(400).json({ error:'Invalid amount' })

  const FEES = { wave:0.015, afrimoney:0.015, qmoney:0.015, bank:0.0125, international:0.0125, crypto:0.01 }
  const net_type  = network || (type?.includes('mobile')?'wave':type?.includes('bank')?'bank':type?.includes('intl')?'international':'crypto')
  const fee       = amount * (FEES[net_type] || 0.015)
  const net       = amount - fee
  const reference = `ALUCARD_${Date.now()}`

  try {
    const body = {
      amount, currency:'GMD',
      account_number: phone || accountNumber || address,
      network: net_type,
      beneficiary_name: accountName || 'Recipient',
      reference,
      description:'(system) Operator: Bun Omar SECKA',
    }
    if (swiftCode) body.swift = swiftCode

    const r = await fetch('https://api.modempay.com/v1/transfers', {
      method:'POST',
      headers:{ Authorization:`Bearer ${b.key}`, 'Content-Type':'application/json' },
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(60000),
    })
    const result = await r.json()
    if (!r.ok) return res.status(500).json({ error:result.message || 'Transfer failed' })

    try { recordTransfer({ type, amount, bridge, recipient:phone||accountNumber||address, status:'submitted', reference }) } catch {}
    broadcast({ type:'transfer', amount, fee, net, reference, status:'submitted' })
    res.json({ ok:true, result, fee, net, reference })
  } catch (e) { res.status(500).json({ error:e.message }) }
})

// ── SOVEREIGN CHAT ─────────────────────────────────────────────────────────────
// Forwards to sovereign worker via message, waits for reply
app.post('/api/chat', auth, async (req, res) => {
  const { message } = req.body
  if (!message) return res.status(400).json({ error:'No message' })
  try {
    const response = await forwardToSovereign(message)
    res.json({ response, ts:Date.now() })
  } catch { res.json({ response:`P${SAB_REF ? new Float64Array(SAB_REF)[0] : 5} — SOVEREIGN online`, ts:Date.now() }) }
})

function forwardToSovereign(message) {
  return new Promise((resolve, reject) => {
    if (!SOVEREIGN_W) return reject(new Error('Sovereign not linked'))
    const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2,8)}`
    chatPending.set(id, resolve)
    SOVEREIGN_W.postMessage({ type:'chat', id, msg:message })
    setTimeout(() => { chatPending.delete(id); reject(new Error('timeout')) }, 8000)
  })
}

// ── WEBSOCKET SERVER ───────────────────────────────────────────────────────────
// Broadcast to ALL connected clients
const WS_CLIENTS = new Set()

function broadcast(data) {
  const payload = JSON.stringify(data)
  for (const ws of WS_CLIENTS) {
    if (ws.readyState === 1) {
      try { ws.send(payload) } catch { WS_CLIENTS.delete(ws) }
    }
  }
}

let _wss = null

function startWSS(server) {
  _wss = new WebSocketServer({ server, perMessageDeflate:false })

  _wss.on('connection', (ws, req) => {
    // PIN from URL query string — the ONLY reliable method for WS upgrade
    let pin = ''
    try {
      const u = new URL(req.url || '/', 'http://x')
      pin = u.searchParams.get('pin') || ''
    } catch {}

    if (String(pin) !== String(ENV_REF.PIN)) {
      ws.send(JSON.stringify({ type:'error', error:'Unauthorized' }))
      ws.close(4001, 'Unauthorized')
      return
    }

    WS_CLIENTS.add(ws)
    // Send full state immediately on connect — no waiting
    ws.send(JSON.stringify(getFullState()))
    ws.on('close',   () => WS_CLIENTS.delete(ws))
    ws.on('error',   () => WS_CLIENTS.delete(ws))
    // Client can send commands via WS too
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'chat' && msg.message) {
          forwardToSovereign(msg.message)
            .then(r => { if(ws.readyState===1) ws.send(JSON.stringify({ type:'chatReply', response:r })) })
            .catch(() => {})
        }
        if (msg.type === 'propeller' && typeof msg.level === 'number') {
          const HOT = new Float64Array(SAB_REF)
          HOT[0] = msg.level
          broadcast({ type:'propeller', level:msg.level, target:getPropellerTarget(msg.level) })
        }
      } catch {}
    })
  })
}

// ── STATE BROADCAST LOOP — every 500ms ────────────────────────────────────────
// Runs unconditionally. Even if SAB has zeros, clients get data.
function startBroadcastLoop() {
  setInterval(() => {
    if (WS_CLIENTS.size === 0) return
    try { broadcast(getFullState()) } catch {}
  }, 500)
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
export function startDashboard(SAB, chains, env, sovereignWorker) {
  SAB_REF      = SAB
  ENV_REF      = env
  SOVEREIGN_W  = sovereignWorker || null

  if (SOVEREIGN_W) {
    SOVEREIGN_W.on('message', msg => {
      if (msg?.type === 'chatReply') {
        const resolve = chatPending.get(msg.id)
        if (resolve) { chatPending.delete(msg.id); resolve(msg.response) }
      }
    })
  }

  const server = createServer(app)
  startWSS(server)
  startBroadcastLoop()

  server.listen(env.PORT, () => console.log(`[DASHBOARD] :${env.PORT} — ${WS_CLIENTS.size} clients`))
}
