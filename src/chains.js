// ═══════════════════════════════════════════════════════════════
// src/chains.js — Worker Thread. All 20 chains. WS + HTTP fallback.
// C/R method: single SWAP_SIG topic covers all Uniswap V3 pools.
// Memory: never holds more than 50 log objects in RAM at once.
// ═══════════════════════════════════════════════════════════════
import { workerData }          from 'worker_threads'
import WebSocket               from 'ws'
import { SWAP_SIG, STABLE0_POOLS } from './config.js'

const { SAB, chains=[] } = workerData
const HOT      = new Float64Array(SAB)
const SIG_C2N  = new Int32Array(SAB, 4080)
const SIG_CTRL = new Int32Array(SAB, 4088)
const C2N_RING = new Float64Array(SAB, 1024, 128)  // 64 slots × 2 floats

let writeHead = 0
const DEAD    = new Set()
const ACTIVE_WS = new Map()

// ── USD DECODE (C/R: one function, covers all pools) ──────────────────────────
function decodeUSD(data, addr) {
  if (!data||data.length<130) return 0
  const hex = data.replace('0x','')
  const H=2n**255n, F=2n**256n
  let a0=BigInt('0x'+hex.slice(0,64)), a1=BigInt('0x'+hex.slice(64,128))
  if(a0>H)a0-=F; if(a1>H)a1-=F
  const abs0=a0<0n?-a0:a0, abs1=a1<0n?-a1:a1
  const stable = STABLE0_POOLS.has((addr||'').toLowerCase()) ? abs0 : abs1
  const usd = Number(stable)/1e6
  return (usd>=1e5&&usd<=1e13&&isFinite(usd)) ? usd : 0
}

// ── PUSH SWAP TO NEXUS ────────────────────────────────────────────────────────
function push(usd, chainId) {
  const slot       = (writeHead%64)*2
  C2N_RING[slot]   = usd
  C2N_RING[slot+1] = chainId
  Atomics.add(SIG_C2N, 0, 1)
  writeHead++
  HOT[7]++  // total swap detections
}

// ── MEMORY PRESSURE RESPONSE ──────────────────────────────────────────────────
// When main thread signals memory pressure, reduce polling frequency
let memPressure = false
setInterval(() => {
  memPressure = Atomics.load(SIG_CTRL,0) === 1
  if (memPressure) Atomics.store(SIG_CTRL,0,0)  // acknowledge
}, 1000)

// ── WS CONNECTION (per chain) ─────────────────────────────────────────────────
function connect(chain, attempt=0) {
  if (DEAD.has(chain.name)) return
  const ws = new WebSocket(chain.ws, { handshakeTimeout:10000 })

  const TO = setTimeout(()=>{ ws.terminate(); if(!DEAD.has(chain.name)) reconnect(chain,attempt+1) }, 15000)

  ws.on('open', ()=>{
    clearTimeout(TO)
    ACTIVE_WS.set(chain.name, ws)
    HOT[40+chains.indexOf(chain)] = 1
    // C/R: one subscription covers all pools via topic filter
    ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_subscribe',params:['logs',{topics:[SWAP_SIG]}]}))
    const ping = setInterval(()=>{ if(ws.readyState===1) ws.ping() }, 20000)
    ws.on('close', ()=>clearInterval(ping))
    console.log(`[CHAINS] ${chain.name} ✓`)
  })

  ws.on('message', raw=>{
    if (memPressure) return  // drop events under memory pressure
    try {
      const m   = JSON.parse(raw.toString())
      const log = m?.params?.result
      if (!log?.topics?.[0]||log.topics[0]!==SWAP_SIG) return
      const usd = decodeUSD(log.data, log.address)
      if (usd>0) push(usd, chain.id)
    } catch {}
    // Immediately null the parsed object — no retention
  })

  ws.on('error', e=>{
    clearTimeout(TO)
    const msg = e.message||''
    if (/ENOTFOUND|EAI_AGAIN|40[134]|405|501/.test(msg)) {
      DEAD.add(chain.name)
      console.warn(`[CHAINS] ${chain.name} dead — HTTP fallback`)
      httpFallback(chain)
    }
  })

  ws.on('close', ()=>{ clearTimeout(TO); HOT[40+chains.indexOf(chain)]=0; ACTIVE_WS.delete(chain.name); reconnect(chain,attempt) })
}

function reconnect(chain, attempt) {
  if (DEAD.has(chain.name)) return
  setTimeout(()=>connect(chain, attempt+1), Math.min(5000*Math.pow(1.5,Math.min(attempt,5)),30000))
}

async function httpFallback(chain) {
  const run = async()=>{
    if (memPressure) return
    try {
      const r = await fetch(chain.http,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{topics:[SWAP_SIG],fromBlock:'latest',toBlock:'latest'}]}),
        signal:AbortSignal.timeout(8000)})
      if(!r.ok) return
      const d = await r.json()
      for (const log of (d.result||[]).slice(0,20)) {  // max 20 per poll — memory safe
        const usd = decodeUSD(log.data, log.address)
        if (usd>0) push(usd, chain.id)
      }
    } catch {}
  }
  setInterval(run, memPressure?30000:12000)
  console.log(`[CHAINS] ${chain.name} HTTP polling`)
}

// Gas updates every 60s
async function updateGas(){
  for (let i=0;i<chains.length;i++){
    try {
      const r = await fetch(chains[i].http,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_gasPrice',params:[]}),signal:AbortSignal.timeout(4000)})
      if(!r.ok) continue
      const d = await r.json()
      if(d.result) HOT[20+i]=parseInt(d.result,16)/1e9
    } catch {}
  }
}

if (!chains.length) { console.warn('[CHAINS] No chains — check config.js') }
else {
  for (const c of chains) {
    if (c.name.includes('solana')||c.name.includes('sonic-2')) httpFallback(c)
    else connect(c)
  }
  setInterval(updateGas, 60000)
  updateGas()
}
