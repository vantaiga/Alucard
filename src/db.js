// src/db.js — FINAL. sql-asm.js (no WASM, no locateFile, no timeout).
// Persists to /data on Railway volume. Survives every restart and redeploy.
import { createRequire }                                from 'module'
import { existsSync, mkdirSync, writeFileSync,
         readFileSync, unlinkSync }                      from 'fs'
import { fileURLToPath }                                 from 'url'
import path                                              from 'path'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
// sql-asm = pure JS asm.js build — no WASM file needed, no locateFile, instant init
const require    = createRequire(import.meta.url)
const initSqlJs  = require(path.join(__dirname, '../node_modules/sql.js/dist/sql-asm.js'))

const DATA_DIR = existsSync('/data')
  ? '/data'
  : (mkdirSync('./data', {recursive:true}), './data')
const DB_PATH  = `${DATA_DIR}/system.db.bin`

let db     = null
let _dirty = false

function _flush() {
  if (!db) return
  try { writeFileSync(DB_PATH, Buffer.from(db.export())) } catch(e) { /* non-fatal */ }
}

// Batch flushes every 10s (not on every write — much faster)
setInterval(() => { if (_dirty) { _flush(); _dirty = false } }, 10_000)
process.on('exit',    _flush)
process.on('SIGTERM', () => { _flush(); process.exit(0) })
process.on('SIGINT',  () => { _flush(); process.exit(0) })

export async function initDB() {
  const SQL = await initSqlJs()

  db = existsSync(DB_PATH)
    ? (() => { try { return new SQL.Database(readFileSync(DB_PATH)) } catch { return new SQL.Database() } })()
    : new SQL.Database()

  db.run(`
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, strategy TEXT DEFAULT '', chain TEXT DEFAULT '',
      profit_usdc REAL DEFAULT 0, flash_amount REAL DEFAULT 0,
      gas_cost REAL DEFAULT 0, status TEXT DEFAULT 'success', tx_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, val TEXT NOT NULL, updated INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS treasury (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      type TEXT DEFAULT 'transfer', amount REAL DEFAULT 0,
      bridge TEXT DEFAULT '', recipient TEXT DEFAULT '',
      status TEXT DEFAULT 'pending', reference TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS overlay_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      chain TEXT DEFAULT 'polygon', strategy TEXT DEFAULT 'rs4',
      profit_est REAL DEFAULT 0, flash_amount REAL DEFAULT 0,
      calldata_hex TEXT DEFAULT '', swap_usd REAL DEFAULT 0,
      pool_addr TEXT DEFAULT '', executed INTEGER DEFAULT 0
    );
  `)

  // Auto-import snapshot if present (one-click server migration)
  const snapCandidates = ['./snapshot.json', `${DATA_DIR}/snapshot.json`]
  for (const p of snapCandidates) {
    if (!existsSync(p)) continue
    try { _importSnapshot(JSON.parse(readFileSync(p,'utf8'))); unlinkSync(p); console.log('[DB] Snapshot imported') }
    catch {}
    break
  }

  _flush()
  console.log(`[DB] Ready → ${DB_PATH}`)
}

function _importSnapshot(snap) {
  for (const [tbl, rows] of Object.entries(snap?.tables ?? {})) {
    if (!Array.isArray(rows) || !rows.length) continue
    const cols = Object.keys(rows[0]).filter(c => c !== 'id')
    const ph   = cols.map(() => '?').join(',')
    for (const row of rows) {
      try { db.run(`INSERT OR REPLACE INTO ${tbl}(${cols.join(',')}) VALUES(${ph})`, cols.map(c => row[c])) } catch {}
    }
  }
}

export function exportSnapshot() {
  const tables = ['executions','config','treasury','overlay_queue']
  const result = {}
  for (const t of tables) {
    try {
      const r = db.exec(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 5000`)
      result[t] = r[0] ? r[0].values.map(row => Object.fromEntries(r[0].columns.map((c,i) => [c,row[i]]))) : []
    } catch { result[t] = [] }
  }
  const snap = { version:'2.0', exportedAt:Date.now(), tables:result }
  const out  = `${DATA_DIR}/snapshot.json`
  writeFileSync(out, JSON.stringify(snap))
  _flush()
  return { path:out, sizeKB:Math.round(JSON.stringify(snap).length/1024) }
}

export const getDB = () => db

export function setConfig(k, v) {
  db.run('INSERT OR REPLACE INTO config(key,val,updated) VALUES(?,?,?)', [k, String(v), Date.now()])
  _dirty = true
}

export function getConfig(k, def=null) {
  try {
    const r = db.exec('SELECT val FROM config WHERE key=?', [k])
    return r[0]?.values[0]?.[0] ?? def
  } catch { return def }
}

export function recordExecution(d) {
  try {
    db.run(
      'INSERT INTO executions(ts,strategy,chain,profit_usdc,flash_amount,gas_cost,status,tx_hash) VALUES(?,?,?,?,?,?,?,?)',
      [Date.now(), d.strategy||'', d.chain||'', d.profit_usdc||0, d.flash_amount||0, d.gas_cost||0, d.status||'success', d.tx_hash||null]
    )
    _dirty = true
  } catch {}
}

export function getExecutions(n=100) {
  try {
    const r = db.exec(`SELECT * FROM executions ORDER BY rowid DESC LIMIT ${+n|0}`)
    return r[0] ? r[0].values.map(row => Object.fromEntries(r[0].columns.map((c,i) => [c,row[i]]))) : []
  } catch { return [] }
}

export function recordTransfer(d) {
  try {
    db.run(
      'INSERT INTO treasury(ts,type,amount,bridge,recipient,status,reference) VALUES(?,?,?,?,?,?,?)',
      [Date.now(), d.type||'transfer', d.amount||0, d.bridge||'', d.recipient||'', d.status||'pending', d.reference||'']
    )
    _dirty = true
  } catch {}
}

export function getTreasuryHistory(n=50) {
  try {
    const r = db.exec(`SELECT * FROM treasury ORDER BY rowid DESC LIMIT ${+n|0}`)
    return r[0] ? r[0].values.map(row => Object.fromEntries(r[0].columns.map((c,i) => [c,row[i]]))) : []
  } catch { return [] }
}
