// ═══════════════════════════════════════════════════════════════════════════
// FILE 9: src/db.js
// SQLite WAL on /data volume. Snapshot export/import. Migration in one click.
// Data lives on Railway /data forever. Moves to server via snapshot.json.
// ═══════════════════════════════════════════════════════════════════════════
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { gzipSync, gunzipSync } from 'zlib'

// Path hierarchy: Railway /data volume → local ./data → create
const DATA_DIR = existsSync('/data') ? '/data' : (mkdirSync('./data',{recursive:true}), './data')
const DB_PATH  = `${DATA_DIR}/system.db`

let db = null

export function getDB() { return db }

export async function initDB() {
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('cache_size = -32000')   // 32MB cache
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456') // 256MB mmap

  // Schema — C/R: one table covers all strategy types
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      strategy TEXT NOT NULL,
      chain TEXT,
      profit_usdc REAL DEFAULT 0,
      flash_amount REAL DEFAULT 0,
      gas_cost REAL DEFAULT 0,
      status TEXT DEFAULT 'success',
      tx_hash TEXT,
      block_number INTEGER
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      val TEXT NOT NULL,
      updated INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS treasury (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      bridge TEXT,
      recipient TEXT,
      status TEXT DEFAULT 'pending',
      reference TEXT
    );
    CREATE TABLE IF NOT EXISTS sovereign_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      dimension TEXT NOT NULL,
      value REAL NOT NULL,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exec_ts       ON executions(ts);
    CREATE INDEX IF NOT EXISTS idx_exec_strategy ON executions(strategy);
    CREATE INDEX IF NOT EXISTS idx_sovereign_dim ON sovereign_memory(dimension);
  `)

  // Import snapshot if present (migration from Railway → server)
  const snapPath = existsSync('./snapshot.json') ? './snapshot.json'
                 : existsSync(`${DATA_DIR}/snapshot.json`) ? `${DATA_DIR}/snapshot.json`
                 : null
  if (snapPath) {
    try {
      const raw  = readFileSync(snapPath)
      const data = JSON.parse(
        raw[0] === 0x1f ? gunzipSync(raw).toString() : raw.toString()
      )
      importSnapshot(data)
      unlinkSync(snapPath)
      console.log('[DB] Snapshot imported — system continues from previous state')
    } catch (e) { console.warn('[DB] Snapshot import failed:', e.message) }
  }

  console.log(`[DB] SQLite WAL ready at ${DB_PATH}`)
}

// ── SNAPSHOT EXPORT (one-click migration via dashboard) ───────────────────────
export function exportSnapshot() {
  const snap = {
    version: '2.0',
    exportedAt: Date.now(),
    tables: {
      executions:      db.prepare('SELECT * FROM executions ORDER BY ts DESC LIMIT 10000').all(),
      config:          db.prepare('SELECT * FROM config').all(),
      treasury:        db.prepare('SELECT * FROM treasury ORDER BY ts DESC LIMIT 1000').all(),
      sovereign_memory:db.prepare('SELECT * FROM sovereign_memory ORDER BY ts DESC LIMIT 5000').all(),
    }
  }
  const compressed = gzipSync(JSON.stringify(snap))
  const outPath = `${DATA_DIR}/snapshot.json`
  writeFileSync(outPath, compressed)
  console.log(`[DB] Snapshot exported: ${(compressed.length/1024).toFixed(1)}KB → ${outPath}`)
  return { path:outPath, size:compressed.length, tables:Object.keys(snap.tables) }
}

function importSnapshot(data) {
  const insert = (table, rows) => {
    if (!rows?.length) return
    const cols = Object.keys(rows[0]).filter(c => c !== 'id')
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`)
    const bulk = db.transaction(rs => rs.forEach(r => stmt.run(cols.map(c=>r[c]))))
    bulk(rows)
  }
  for (const [table, rows] of Object.entries(data.tables||{})) {
    try { insert(table, rows) } catch {}
  }
}

// ── CRUD HELPERS ───────────────────────────────────────────────────────────────
export const setConfig = (key, val) =>
  db.prepare('INSERT OR REPLACE INTO config(key,val,updated) VALUES(?,?,unixepoch())').run(key, String(val))

export const getConfig = (key, def=null) => {
  const r = db.prepare('SELECT val FROM config WHERE key=?').get(key)
  return r ? r.val : def
}

export const recordExecution = (data) =>
  db.prepare('INSERT INTO executions(ts,strategy,chain,profit_usdc,flash_amount,gas_cost,status,tx_hash) VALUES(?,?,?,?,?,?,?,?)')
    .run(Date.now(), data.strategy||'', data.chain||'', data.profit_usdc||0, data.flash_amount||0, data.gas_cost||0, data.status||'success', data.tx_hash||null)

export const getExecutions = (limit=100) =>
  db.prepare('SELECT * FROM executions ORDER BY ts DESC LIMIT ?').all(limit)

export const getTreasuryHistory = (limit=50) =>
  db.prepare('SELECT * FROM treasury ORDER BY ts DESC LIMIT ?').all(limit)

export const recordTransfer = (data) =>
  db.prepare('INSERT INTO treasury(ts,type,amount,bridge,recipient,status,reference) VALUES(?,?,?,?,?,?,?)')
    .run(Date.now(), data.type||'transfer', data.amount||0, data.bridge||'', data.recipient||'', data.status||'pending', data.reference||'')
