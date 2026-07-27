// ═══════════════════════════════════════════════════════════════
// src/db.js — sql-asm.js (pure JS, no WASM). /data persistence.
// Batched flush every 10s. Snapshot export/import for migration.
// Memory: sql-asm heap capped, never grows unboundedly.
// ═══════════════════════════════════════════════════════════════
import { createRequire }                          from 'module'
import { existsSync, mkdirSync, writeFileSync,
         readFileSync, unlinkSync }               from 'fs'
import { fileURLToPath }                          from 'url'
import path                                       from 'path'

const __dir   = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const SQL     = await require(path.join(__dir,'../node_modules/sql.js/dist/sql-asm.js'))()

const DIR  = existsSync('/data')?'/data':(mkdirSync('./data',{recursive:true}),'./data')
const BIN  = `${DIR}/system.db.bin`
let db     = null
let dirty  = false

const flush = ()=>{ if(!db)return; try{writeFileSync(BIN,Buffer.from(db.export()))}catch{} }
setInterval(()=>{ if(dirty){flush();dirty=false} },10000)
process.on('exit',flush)
process.on('SIGTERM',()=>{flush();process.exit(0)})
process.on('SIGINT', ()=>{flush();process.exit(0)})

export async function initDB(){
  db = existsSync(BIN) ? (()=>{ try{return new SQL.Database(readFileSync(BIN))}catch{return new SQL.Database()} })() : new SQL.Database()
  db.run(`
    CREATE TABLE IF NOT EXISTS executions(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,strategy TEXT DEFAULT '',chain TEXT DEFAULT '',profit_usdc REAL DEFAULT 0,flash_amount REAL DEFAULT 0,status TEXT DEFAULT 'success',tx_hash TEXT);
    CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,val TEXT NOT NULL,updated INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS treasury(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,type TEXT DEFAULT 'transfer',amount REAL DEFAULT 0,bridge TEXT DEFAULT '',recipient TEXT DEFAULT '',status TEXT DEFAULT 'pending',reference TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS overlay_queue(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,chain TEXT DEFAULT 'polygon',strategy TEXT DEFAULT 'rs4',profit_est REAL DEFAULT 0,flash_amount REAL DEFAULT 0,swap_usd REAL DEFAULT 0,pool_addr TEXT DEFAULT '',executed INTEGER DEFAULT 0);
  `)
  for(const p of ['./snapshot.json',`${DIR}/snapshot.json`]){
    if(!existsSync(p))continue
    try{_import(JSON.parse(readFileSync(p,'utf8')));unlinkSync(p);console.log('[DB] Snapshot imported')}catch{}
    break
  }
  flush()
  console.log(`[DB] Ready → ${BIN}`)
}

function _import(snap){
  for(const[t,rows]of Object.entries(snap?.tables??{})){
    if(!Array.isArray(rows)||!rows.length)continue
    const cols=Object.keys(rows[0]).filter(c=>c!=='id')
    const ph=cols.map(()=>'?').join(',')
    for(const row of rows){try{db.run(`INSERT OR REPLACE INTO ${t}(${cols.join(',')})VALUES(${ph})`,cols.map(c=>row[c]))}catch{}}
  }
}

export function exportSnapshot(){
  const tables=['executions','config','treasury','overlay_queue']
  const result={}
  for(const t of tables){try{const r=db.exec(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT 5000`);result[t]=r[0]?r[0].values.map(row=>Object.fromEntries(r[0].columns.map((c,i)=>[c,row[i]]))):[];}catch{result[t]=[]}}
  const snap={version:'2.0',exportedAt:Date.now(),tables:result}
  const out=`${DIR}/snapshot.json`
  writeFileSync(out,JSON.stringify(snap)); flush()
  return{path:out,sizeKB:Math.round(JSON.stringify(snap).length/1024)}
}

export const getDB=()=>db
export function setConfig(k,v){db.run('INSERT OR REPLACE INTO config(key,val,updated)VALUES(?,?,?)',[k,String(v),Date.now()]);dirty=true}
export function getConfig(k,def=null){try{const r=db.exec('SELECT val FROM config WHERE key=?',[k]);return r[0]?.values[0]?.[0]??def}catch{return def}}
export function recordExecution(d){try{db.run('INSERT INTO executions(ts,strategy,chain,profit_usdc,flash_amount,status,tx_hash)VALUES(?,?,?,?,?,?,?)',[Date.now(),d.strategy||'',d.chain||'',d.profit_usdc||0,d.flash_amount||0,d.status||'success',d.tx_hash||null]);dirty=true}catch{}}
export function getExecutions(n=100){try{const r=db.exec(`SELECT * FROM executions ORDER BY rowid DESC LIMIT ${+n|0}`);return r[0]?r[0].values.map(row=>Object.fromEntries(r[0].columns.map((c,i)=>[c,row[i]]))):[];}catch{return[]}}
export function recordTransfer(d){try{db.run('INSERT INTO treasury(ts,type,amount,bridge,recipient,status,reference)VALUES(?,?,?,?,?,?,?)',[Date.now(),d.type||'transfer',d.amount||0,d.bridge||'',d.recipient||'',d.status||'pending',d.reference||'']);dirty=true}catch{}}
export function getTreasuryHistory(n=50){try{const r=db.exec(`SELECT * FROM treasury ORDER BY rowid DESC LIMIT ${+n|0}`);return r[0]?r[0].values.map(row=>Object.fromEntries(r[0].columns.map((c,i)=>[c,row[i]]))):[];}catch{return[]}}
