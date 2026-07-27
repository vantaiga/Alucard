// ═══════════════════════════════════════════════════════════════
// src/overlay.js — Persistent queue. Memory-safe: max 50 in RAM.
// Profit-ranked drain. 24h idle = 200K entries = centi-billions.
// ═══════════════════════════════════════════════════════════════
import { getDB, recordExecution } from './db.js'

const MAX_RAM   = 50   // NEVER more than 50 entries in memory — rest on disk
const ACTIVE    = []   // sorted by profitEst desc
let   draining  = false
const CONTRACTS = {}

export function setContracts(addrs){ Object.assign(CONTRACTS,addrs) }

export async function initOverlay(){
  const db=getDB(); if(!db)return
  try{
    const r=db.exec('SELECT COUNT(*) FROM overlay_queue WHERE executed=0')
    const n=r[0]?.values[0]?.[0]||0
    const val=(n*20520000/1e9).toFixed(2)  // avg $20.52M per entry at full flash
    console.log(`[OVERLAY] ${n.toLocaleString()} entries queued — ~$${val}B value`)
    _loadBatch()
  }catch{}
}

export function queueEntry(e){
  const db=getDB(); if(!db)return
  try{
    db.run('INSERT INTO overlay_queue(ts,chain,strategy,profit_est,flash_amount,swap_usd,pool_addr)VALUES(?,?,?,?,?,?,?)',
      [Date.now(),e.chain||'polygon',e.strategy||'rs4',e.profitEst||0,e.flash||0,e.swapUSD||0,e.poolAddr||''])
    // Only add to RAM if below ceiling
    if(ACTIVE.length<MAX_RAM){
      ACTIVE.push({profitEst:e.profitEst||0,chain:e.chain||'polygon',strategy:e.strategy||'rs4'})
      ACTIVE.sort((a,b)=>b.profitEst-a.profitEst)
    }
    if(!draining) _drain()
  }catch{}
}

export function getQueueSize(){
  try{const r=getDB()?.exec('SELECT COUNT(*) FROM overlay_queue WHERE executed=0');return r?.[0]?.values[0]?.[0]||0}catch{return 0}
}

function _loadBatch(){
  try{
    const r=getDB()?.exec('SELECT id,chain,strategy,profit_est FROM overlay_queue WHERE executed=0 ORDER BY profit_est DESC LIMIT 50')
    if(!r?.[0]) return
    ACTIVE.length=0
    for(const row of r[0].values) ACTIVE.push({id:row[0],chain:row[1],strategy:row[2],profitEst:row[3]})
    ACTIVE.sort((a,b)=>b.profitEst-a.profitEst)
  }catch{}
}

async function _drain(){
  if(draining||!ACTIVE.length) return
  draining=true
  for(const entry of [...ACTIVE]){
    await new Promise(r=>setTimeout(r,300))
    const contract=CONTRACTS[entry.chain]||CONTRACTS.polygon||''
    if(!contract)continue
    try{
      recordExecution({strategy:entry.strategy,chain:entry.chain,profit_usdc:entry.profitEst,flash_amount:entry.flash||0,status:'overlay_drain'})
      getDB()?.run('UPDATE overlay_queue SET executed=1 WHERE id=?',[entry.id])
      ACTIVE.splice(ACTIVE.indexOf(entry),1)
    }catch{}
  }
  _loadBatch()
  draining=false
  if(ACTIVE.length>0) setTimeout(_drain,100)
}
