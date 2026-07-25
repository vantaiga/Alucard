// ═══════════════════════════════════════════════════════════════════════════
// FILE 11: src/dashboard.js
// Express server for Daybreak/Nightfall/all dashboards.
// WebSocket state feed, propeller API, snapshot API, settlement API.
// Every data point in the system flows through here.
// ═══════════════════════════════════════════════════════════════════════════
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { getDB, getConfig, setConfig, getExecutions, exportSnapshot } from './db.js'
import { getQueueSize } from './overlay.js'
import { getBridgeList, send, getBalance, getMode, calcFee } from './settlement.js'
import { getTreasury, calcYield } from './treasury.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PIN       = process.env.DASHBOARD_PASSKEY || '3530588'
const PORT      = parseInt(process.env.PORT) || 3000

let SAB_REF = null
let CHAINS_REF = []

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const pin = req.headers['x-pin'] || req.query.pin
  if (pin !== PIN) return res.status(401).json({ error:'Invalid PIN' })
  next()
}

export function startDashboard(SAB, chains) {
  SAB_REF    = SAB
  CHAINS_REF = chains
  const HOT  = new Float64Array(SAB)

  const app  = express()
  const srv  = createServer(app)
  const wss  = new WebSocketServer({ server: srv })

  app.use(express.json())
  app.use(express.static(path.join(__dirname, '../dashboard')))

  // ── PROPELLER API ────────────────────────────────────────────────────────────
  app.post('/api/propeller', auth, (req, res) => {
    const { level } = req.body
    if (typeof level !== 'number' || level < 0 || level > 50) return res.status(400).json({ error:'Invalid level 0-50' })
    HOT[0] = level
    setConfig('propeller_level', level)
    // Dynamic P30 update based on chain count
    const chainCount  = CHAINS_REF.length
    const p30_dynamic = (chainCount / 20) * 8.7e15
    res.json({ ok:true, level, p30Revenue: p30_dynamic, chainCount })
  })

  app.get('/api/state', auth, (req, res) => {
    const treasury = getTreasury(SAB)
    const chainCount = CHAINS_REF.length
    const p30Dynamic = (chainCount / 20) * 8.7e15
    res.json({
      propeller:    HOT[0],
      dailyRevenue: HOT[1],
      crashSignal:  HOT[102],
      treasury:     treasury.balance,
      reserve:      treasury.reserve,
      flashBase:    HOT[22],
      flashTotal:   HOT[22] + HOT[104],
      queueSize:    getQueueSize(),
      executions:   HOT[146],
      uptime:       HOT[150],
      chainCount,
      p30Dynamic,
      bridges:      getBridgeList(),
      bridgeModes:  Object.fromEntries(getBridgeList().map(b => [b, getMode(b)])),
      dailyYield:   calcYield(treasury.balance),
    })
  })

  app.get('/api/executions', auth, (req, res) => res.json(getExecutions(parseInt(req.query.limit)||100)))
  app.get('/api/treasury',   auth, (req, res) => {
    const db = getDB()
    res.json({
      history: db.prepare('SELECT * FROM treasury ORDER BY ts DESC LIMIT 50').all(),
      ...getTreasury(SAB),
      yield:   calcYield(getTreasury(SAB).balance),
    })
  })

  // ── SETTLEMENT API (bridge-agnostic, 3 formats) ───────────────────────────────
  app.post('/api/transfer', auth, async (req, res) => {
    const { type, bridge='modempay', ...params } = req.body
    // type: 'domestic_mobile' | 'domestic_bank' | 'international' | 'crypto'
    try {
      const fee    = calcFee(params.amount, params.network || 'wave')
      const result = await send(bridge, params)
      const db     = getDB()
      db.prepare('INSERT INTO treasury(ts,type,amount,bridge,recipient,status,reference) VALUES(?,?,?,?,?,?,?)')
        .run(Date.now(), type, params.amount, bridge, params.phone||params.accountNumber||params.address||'', 'pending', result.id||`REF_${Date.now()}`)
      res.json({ ok:true, result, fee })
    } catch(e) { res.status(500).json({ error:e.message }) }
  })

  app.get('/api/bridges',         auth, (req, res) => res.json({ bridges:getBridgeList(), modes:Object.fromEntries(getBridgeList().map(b=>[b,getMode(b)])) }))
  app.get('/api/fee',             auth, (req, res) => res.json(calcFee(parseFloat(req.query.amount)||0, req.query.network||'wave')))
  app.get('/api/balance/:bridge', auth, async (req, res) => { try { res.json(await getBalance(req.params.bridge)) } catch(e) { res.status(500).json({error:e.message}) } })

  // ── SNAPSHOT / MIGRATION ─────────────────────────────────────────────────────
  app.post('/api/system/snapshot', auth, (req, res) => {
    try {
      const result = exportSnapshot()
      res.json({ ok:true, ...result, instruction:'Download snapshot.json and place in repo root for server migration.' })
    } catch(e) { res.status(500).json({ error:e.message }) }
  })

  app.get('/api/system/snapshot/download', auth, (req, res) => {
    const p = existsSync('/data/snapshot.json') ? '/data/snapshot.json' : './data/snapshot.json'
    if (!existsSync(p)) return res.status(404).json({ error:'No snapshot. POST /api/system/snapshot first.' })
    res.download(p, 'snapshot.json')
  })

  // ── SOVEREIGN CHAT ────────────────────────────────────────────────────────────
  app.post('/api/sovereign/chat', auth, async (req, res) => {
    const { message } = req.body
    // Import sovereign chat function
    try {
      const { chat } = await import('./sovereign.js')
      res.json({ response: chat(message), ts:Date.now() })
    } catch { res.json({ response:`P${HOT[0]} | Revenue: $${(HOT[1]/1e12).toFixed(4)}T | Signal: ${HOT[102]}/100`, ts:Date.now() }) }
  })

  // ── SOVEREIGN COMMANDS VIA DASHBOARD ─────────────────────────────────────────
  app.post('/api/sovereign/command', auth, (req, res) => {
    const { command } = req.body
    if (command === 'halt')   { HOT[0] = 0;   return res.json({ ok:true, action:'halted' }) }
    if (command === 'crash')  { HOT[0] = 50; HOT[102] = 100; return res.json({ ok:true, action:'crash_mode' }) }
    if (command === 'resume') { HOT[0] = parseFloat(getConfig('propeller_level')||'5'); return res.json({ ok:true, action:'resumed' }) }
    res.status(400).json({ error:'Unknown command' })
  })

  // ── WEBSOCKET — LIVE STATE FEED ──────────────────────────────────────────────
  // Streams all system data to Daybreak dashboard every 500ms
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.searchParams.get('pin') !== PIN) { ws.close(4001, 'Unauthorized'); return }

    const interval = setInterval(() => {
      if (ws.readyState !== 1) { clearInterval(interval); return }
      try {
        ws.send(JSON.stringify({
          type:         'state',
          ts:           Date.now(),
          propeller:    HOT[0],
          dailyRevenue: HOT[1],
          crashSignal:  HOT[102],
          treasury:     HOT[103],
          reserve:      HOT[104],
          flashTotal:   HOT[22] + HOT[104],
          queueSize:    getQueueSize(),
          executions:   HOT[146],
          uptime:       HOT[150],
          chains:       CHAINS_REF.map((c,i) => ({ name:c.name, active:!!HOT[82+i], gas:HOT[62+i] })),
          chainCount:   CHAINS_REF.length,
          p30Dynamic:   (CHAINS_REF.length/20)*8.7e15,
        }))
      } catch { clearInterval(interval) }
    }, 500)

    ws.on('close', () => clearInterval(interval))
  })

  srv.listen(PORT, () => console.log(`[DASHBOARD] Listening on :${PORT} — PIN protected`))
}
