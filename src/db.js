// src/db.js — REDRAFT: sql.js pure JS, no native compilation, survives Railway free tier
// Persistence: export to /data/system.db.bin on every write batch
// Reload: import from /data/system.db.bin on boot
// Migration: snapshot.json auto-imported if present
import { createRequire }                      from 'module'
import { existsSync, mkdirSync, writeFileSync,
         readFileSync, unlinkSync }            from 'fs'

const require   = createRequire(import.meta.url)
const initSqlJs = require('sql.js')

// Storage paths
const DATA_DIR  = existsSync('/data') ? '/data' : (() => { mkdirSync('./data',{recursive:true}); return './data' })()
const DB_BIN    = `${DATA_DIR}/system.db.bin`
const SNAP_PATH = existsSync('./snapshot.json') ? './snapshot.json'
                : existsSync(`${DATA_DIR}/snapshot.json`) ? `${DATA_DIR}/snapshot.json`
                : null

let SQL = null
let db  = null

// Periodic flush to disk (every 10s — not on every write, for performance)
let _dirty = false
setInterval(() => { if (_dirty) { _flush(); _dirty = false } }, 10000)

function _flush() {
  try { writeFileSync(DB_BIN, Buffer.from(db.export())) } catch {}
}

export function getDB() { return db }

export async function initDB() {
  SQL = await initSqlJs()

  // Load existing DB or create fresh
  if (existsSync(DB_BIN)) {
    try {
      db = new SQL.Database(readFileSync(DB_BIN))
      console.log(`[DB] Loaded existing database from ${DB_BIN}`)
    } catch {
      db = new SQL.Database()
      console.warn('[DB] Corrupted DB — starting fresh')
    }
  } else {
    db = new SQL.Database()
    console.log(`[DB] New database created at ${DB_BIN}`)
  }

  // Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS executions (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts    INTEGER NOT NULL,
      strategy TEXT NOT NULL DEFAULT '',
      chain    TEXT         DEFAULT '',
      profit_usdc  REAL     DEFAULT 0,
      flash_amount REAL     DEFAULT 0,
      gas_cost     REAL     DEFAULT 0,
      status       TEXT     DEFAULT 'success',
      tx_hash      TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      key  TEXT PRIMARY KEY,
      val  TEXT NOT NULL,
      updated INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS treasury (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      type      TEXT NOT NULL DEFAULT 'transfer',
      amount    REAL NOT NULL DEFAULT 0,
      bridge    TEXT DEFAULT '',
      recipient TEXT DEFAULT '',
      status    TEXT DEFAULT 'pending',
      reference TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS overlay_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      chain       TEXT NOT NULL DEFAULT 'polygon',
      strategy    TEXT DEFAULT 'rs4',
      profit_est  REAL NOT NULL DEFAULT 0,
      flash_amount REAL DEFAULT 0,
      calldata_hex TEXT,
      swap_usd    REAL DEFAULT 0,
      pool_addr   TEXT DEFAULT '',
      executed    INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sovereign_memory (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      value     REAL NOT NULL DEFAULT 0,
      source    TEXT DEFAULT ''
    );
  `)

  // Import snapshot if present (Railway → server migration)
  if (SNAP_PATH) {
    try {
      const raw  = readFileSync(SNAP_PATH, 'utf8')
      const data = JSON.parse(raw)
      _importSnapshot(data)
      unlinkSync(SNAP_PATH)
      console.log('[DB] Snapshot imported — system continues from previous state')
    } catch (e) { console.warn('[DB] Snapshot import failed:', e.message) }
  }

  // Initial flush
  _flush()
  console.log('[DB] sql.js ready — pure JS, no native compilation')
}

function _importSnapshot(data) {
  for (const [table, rows] of Object.entries(data.tables || {})) {
    if (!Array.isArray(rows) || !rows.length) continue
    const cols = Object.keys(rows[0]).filter(c => c !== 'id')
    const placeholders = cols.map(() => '?').join(',')
    const stmt = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`
    for (const row of rows) {
      try { db.run(stmt, cols.map(c => row[c])) } catch {}
    }
  }
}

export function exportSnapshot() {
  const tables = ['executions','config','treasury','overlay_queue','sovereign_memory']
  const snap = {
    version: '2.0',
    exportedAt: Date.now(),
    tables: Object.fromEntries(tables.map(t => {
      try { return [t, db.exec(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 10000`)[0]?.values?.map(row =>
        Object.fromEntries(db.exec(`SELECT * FROM ${t} LIMIT 0`)[0]?.columns?.map((c,i) => [c, row[i]]) ?? [])
      ) ?? []] } catch { return [t, []] }
    }))
  }
  // Simpler approach for sql.js
  const result = {}
  for (const t of tables) {
    try {
      const r = db.exec(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 5000`)
      if (r[0]) {
        result[t] = r[0].values.map(row => Object.fromEntries(r[0].columns.map((c,i)=>[c,row[i]])))
      } else { result[t] = [] }
    } catch { result[t] = [] }
  }
  const snap2 = { version:'2.0', exportedAt:Date.now(), tables:result }
  const out   = `${DATA_DIR}/snapshot.json`
  writeFileSync(out, JSON.stringify(snap2))
  _flush()
  return { path:out, size:JSON.stringify(snap2).length }
}

// ── CRUD — thin wrappers ───────────────────────────────────────────────────────
export function setConfig(key, val) {
  db.run('INSERT OR REPLACE INTO config(key,val,updated) VALUES(?,?,?)', [key, String(val), Date.now()])
  _dirty = true
}

export function getConfig(key, def=null) {
  try {
    const r = db.exec(`SELECT val FROM config WHERE key='${key.replace(/'/g,"''")}'`)
    return r[0]?.values[0]?.[0] ?? def
  } catch { return def }
}

export function recordExecution(data) {
  db.run(
    'INSERT INTO executions(ts,strategy,chain,profit_usdc,flash_amount,gas_cost,status,tx_hash) VALUES(?,?,?,?,?,?,?,?)',
    [Date.now(), data.strategy||'', data.chain||'', data.profit_usdc||0, data.flash_amount||0, data.gas_cost||0, data.status||'success', data.tx_hash||null]
  )
  _dirty = true
}

export function getExecutions(limit=100) {
  try {
    const r = db.exec(`SELECT * FROM executions ORDER BY rowid DESC LIMIT ${parseInt(limit)}`)
    if (!r[0]) return []
    return r[0].values.map(row => Object.fromEntries(r[0].columns.map((c,i)=>[c,row[i]])))
  } catch { return [] }
}

export function recordTransfer(data) {
  db.run(
    'INSERT INTO treasury(ts,type,amount,bridge,recipient,status,reference) VALUES(?,?,?,?,?,?,?)',
    [Date.now(), data.type||'transfer', data.amount||0, data.bridge||'', data.recipient||'', data.status||'pending', data.reference||'']
  )
  _dirty = true
}

export function getTreasuryHistory(limit=50) {
  try {
    const r = db.exec(`SELECT * FROM treasury ORDER BY rowid DESC LIMIT ${parseInt(limit)}`)
    if (!r[0]) return []
    return r[0].values.map(row => Object.fromEntries(r[0].columns.map((c,i)=>[c,row[i]])))
  } catch { return [] }
}

// Flush on exit
process.on('exit',    _flush)
process.on('SIGTERM', () => { _flush(); process.exit(0) })
process.on('SIGINT',  () => { _flush(); process.exit(0) })
