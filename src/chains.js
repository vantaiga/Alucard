// src/chains.js — FINAL. Worker Thread. WS with full error handling.
// C/R method: single Swap topic covers all pools. Polling-based SAB writes.
import { workerData } from 'worker_threads'
import WebSocket       from 'ws'
import { queueEntry }  from './overlay.js'

const { SAB, chains = [] } = workerData
const HOT        = new Float64Array(SAB)
const SIG_CHAINS = new Int32Array(SAB, 4080)

// Chains→Nexus ring buffer (byte 1024, 64 slots × 16 bytes)
const CHAIN_RING = new Float64Array(SAB, 1024, 128)
let   writeHead  = 0

// Swap event topic (Uniswap V3)
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// Stable-token-0 pools (USDC is token0 — use abs0/1e6 for USD decode)
const STABLE0 = new Set([
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
  '0x45dda9cb7c25131df268515131f647d726f50608',
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b5',
  '0xc6962004f452be9203591991d15f6b388e09e8d0',
  '0x1fb3cf6e48f1e7b10213e7b6d87d4c073c7fdb7',
  '0x36696169c63e42cd08ce11f5deebbbcebae652050',
])

function decodeSwapUSD(data, addr) {
  if (!data || data.length < 130) return 0
  const hex = data.replace('0x','')
  const H   = 2n**255n, F = 2n**256n
  let a0    = BigInt('0x'+hex.slice(0,64))
  let a1    = BigInt('0x'+hex.slice(64,128))
  if (a0>H) a0-=F;  if (a1>H) a1-=F
  const abs0 = a0<0n?-a0:a0, abs1 = a1<0n?-a1:a1
  const stable = STABLE0.has((addr||'').toLowerCase()) ? abs0 : abs1
  const usd    = Number(stable) / 1e6
  return (usd >= 1e5 && usd <= 1e13 && isFinite(usd)) ? usd : 0
}

function pushSwap(usd, chainId) {
  const slot  = (writeHead % 64) * 2
  CHAIN_RING[slot]   = usd
  CHAIN_RING[slot+1] = chainId
  Atomics.add(SIG_CHAINS, 0, 1)
  writeHead++
  HOT[7]++  // increment execution counter
  // Also queue in overlay (pre-deploy accumulation)
  queueEntry({ swapUSD:usd, profitEst:usd*0.00045, flash:Math.min(usd*10, 45.59e9), chain:'polygon' })
}

const DEAD = new Set()

function connect(chain, attempt=0) {
  if (DEAD.has(chain.name)) return
  const ws = new WebSocket(chain.ws, { handshakeTimeout:10000 })
  let alive = false

  const timeout = setTimeout(() => {
    if (!alive) { ws.terminate(); DEAD.add(chain.name); startHTTP(chain) }
  }, 15000)

  ws.on('open', () => {
    alive = true; clearTimeout(timeout)
    HOT[30 + chains.indexOf(chain)] = 1  // chain active flag
    ws.send(JSON.stringify({ jsonrpc:'2.0',id:1,method:'eth_subscribe',params:['logs',{topics:[SWAP_TOPIC]}] }))
    console.log(`[CHAINS] ${chain.name} connected`)
    // Ping keepalive
    const ping = setInterval(() => { if (ws.readyState===1) ws.ping() }, 20000)
    ws.on('close', () => clearInterval(ping))
  })

  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString())
      const log = m?.params?.result
      if (!log?.topics?.[0]) return
      if (log.topics[0] !== SWAP_TOPIC) return
      const usd = decodeSwapUSD(log.data, log.address)
      if (usd > 0) pushSwap(usd, chain.id)
    } catch {}
  })

  ws.on('error', e => {
    clearTimeout(timeout)
    const msg = e.message||''
    if (/ENOTFOUND|EAI_AGAIN|40[134]|405|501/.test(msg)) { DEAD.add(chain.name); startHTTP(chain) }
  })

  ws.on('close', () => {
    clearTimeout(timeout)
    HOT[30 + chains.indexOf(chain)] = 0
    if (!DEAD.has(chain.name)) {
      const delay = Math.min(5000 * Math.pow(1.5, Math.min(attempt,5)), 30000)
      setTimeout(() => connect(chain, attempt+1), delay)
    }
  })
}

async function startHTTP(chain) {
  const poll = async () => {
    try {
      const r = await fetch(chain.http, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{topics:[SWAP_TOPIC],fromBlock:'latest',toBlock:'latest'}]}),
        signal:AbortSignal.timeout(8000)
      })
      if (!r.ok) return
      const d = await r.json()
      for (const log of d.result||[]) {
        const usd = decodeSwapUSD(log.data, log.address)
        if (usd > 0) pushSwap(usd, chain.id)
      }
    } catch {}
  }
  setInterval(poll, 12000)
  console.log(`[CHAINS] ${chain.name} → HTTP fallback`)
}

// Gas price updates every 60s
async function updateGas() {
  for (let i=0; i<chains.length; i++) {
    try {
      const r = await fetch(chains[i].http, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_gasPrice',params:[]}),
        signal:AbortSignal.timeout(5000)
      })
      if (!r.ok) continue
      const d = await r.json()
      if (d.result) HOT[10+i] = parseInt(d.result,16)/1e9
    } catch {}
  }
}

// Boot
if (!chains.length) {
  console.warn('[CHAINS] No chains configured — add Alchemy URLs to env vars')
} else {
  for (const c of chains) {
    if (c.name === 'solana-mainnet') { startHTTP(c); continue }
    connect(c)
  }
  setInterval(updateGas, 60_000)
  updateGas()
}
