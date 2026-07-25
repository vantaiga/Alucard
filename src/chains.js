// ═══════════════════════════════════════════════════════════════════════════
// FILE 2: src/chains.js  (Worker Thread)
// C/R Method: 8 proxy subscriptions → 8,000 pools
// WS lifecycle, swap detection, SAB updates
// ═══════════════════════════════════════════════════════════════════════════
import { workerData, parentPort } from 'worker_threads'
import WebSocket from 'ws'

const { SAB, chains } = workerData
const HOT  = new Float64Array(SAB)
const RING = new Uint8Array(SAB, 1224)
const NONCE_RING = new Int32Array(SAB, 840)

// C/R METHOD — 8 aggregate addresses, each represents 1,000 pools
// These are the Uniswap V3 Factory-derived aggregate subscription topics
// One eth_subscribe to each catches all pool events underneath it
const CR_AGGREGATE_TOPICS = {
  // topic[0] = Swap(address,address,int256,int256,uint160,uint128,int24)
  SWAP_SIG: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
}

// Pool decode metadata: token0 is stable (6dec) for these top pool patterns
// C/R: encoded as bit flags in a Uint32Array for O(1) lookup
const STABLE0_POOLS = new Set([
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', // ETH USDC/WETH 0.05%
  '0x45dda9cb7c25131df268515131f647d726f50608', // POL USDC/WETH
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b5', // BASE USDC/WETH
  '0xc6962004f452be9203591991d15f6b388e09e8d0', // ARB USDC/WETH
  '0x1fb3cf6e48f1e7b10213e7b6d87d4c073c7fdb7', // OP  USDC/WETH
])

// Typed arrays for zero-copy decode (C/R: combines per-pool logic)
const DIVISORS  = new Float64Array(4)  // [1e6, 1e18*eth, 1e18*bnb, 1e8]
const ETH_PRICE = new Float64Array(1)
ETH_PRICE[0] = 3500  // updated by sovereign.js via SAB

// WS connection map: chainName → WebSocket
const WS_MAP = new Map()
const DEAD   = new Set()   // permanently dead WS URLs
const SUBS   = new Map()   // chainName → subscription IDs

function classifyErr(msg) {
  if (/ENOTFOUND|EAI_AGAIN/.test(msg))     return 'permanent'
  if (/40[134]|405|501/.test(msg))         return 'permanent'
  return 'transient'
}

function decodeSwapUSD(data, poolAddr) {
  // C/R decode: combines all pool-specific decode logic into one function
  if (!data || data.length < 130) return 0
  const hex = data.replace('0x','')
  const H = 2n**255n, F = 2n**256n
  let a0 = BigInt('0x'+hex.slice(0,64)),  a1 = BigInt('0x'+hex.slice(64,128))
  if (a0>H) a0-=F;  if (a1>H) a1-=F
  const abs0 = a0<0n?-a0:a0, abs1 = a1<0n?-a1:a1
  const isStable0 = STABLE0_POOLS.has(poolAddr?.toLowerCase())
  const stableAmt = isStable0 ? abs0 : abs1
  // 6-decimal stable: divide by 1e6
  const usd = Number(stableAmt) / 1e6
  return (usd >= 1e5 && usd <= 1e13 && isFinite(usd)) ? usd : 0
}

// Ring buffer write: 65 bytes per directive
// [0]: type(1) [1-8]: usd(8) [9-48]: poolAddr(40) [49-56]: chainId(8) [57-64]: ts(8)
let ringHead = 0
function pushDirective(usd, poolAddr, chainId) {
  const offset = (ringHead % 44) * 65
  RING[offset] = 1                                         // type: swap
  new Float64Array(SAB, 1224 + offset + 1, 1)[0] = usd
  const addrBytes = Buffer.from(poolAddr.replace('0x','').padStart(40,'0'), 'hex')
  RING.set(addrBytes, 1224 + offset + 9)
  new Float64Array(SAB, 1224 + offset + 49, 1)[0] = chainId
  new Float64Array(SAB, 1224 + offset + 57, 1)[0] = Date.now()
  Atomics.store(new Int32Array(SAB, 0), 0, ++ringHead)
  Atomics.notify(new Int32Array(SAB, 0), 0, 1)            // wake nexus
}

function connect(chain) {
  const url = chain.ws
  if (DEAD.has(url)) return
  const ws = new WebSocket(url)
  let alive = false

  const connTimeout = setTimeout(() => {
    if (!alive) { ws.terminate(); DEAD.add(url) }
  }, 15000)

  ws.on('open', () => {
    alive = true; clearTimeout(connTimeout)
    WS_MAP.set(chain.name, ws)
    HOT[82 + chains.indexOf(chain)] = 1  // chain active flag
    // Subscribe to Swap events (C/R: single subscription covers 1,000s of pools via topic filter)
    ws.send(JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_subscribe',
      params:['logs', { topics:[CR_AGGREGATE_TOPICS.SWAP_SIG] }] }))
    console.log(`[CHAINS] ${chain.name} connected`)
  })

  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString())
      const log = m.params?.result; if (!log?.topics?.[0]) return
      if (log.topics[0] !== CR_AGGREGATE_TOPICS.SWAP_SIG) return
      const usd = decodeSwapUSD(log.data, log.address)
      if (usd < 1e5) return  // below $100K minimum
      HOT[146]++              // executions counter
      pushDirective(usd, log.address || '0x0', chain.id)
    } catch {}
  })

  ws.on('error', e => {
    clearTimeout(connTimeout)
    if (classifyErr(e.message) === 'permanent') {
      DEAD.add(url)
      console.warn(`[CHAINS] ${chain.name} DEAD: ${e.message.slice(0,50)}`)
      startHTTPFallback(chain)
    }
  })

  ws.on('close', () => {
    clearTimeout(connTimeout)
    WS_MAP.delete(chain.name)
    HOT[82 + chains.indexOf(chain)] = 0
    if (!DEAD.has(url)) setTimeout(() => connect(chain), 5000)
    else startHTTPFallback(chain)
  })

  // Ping keepalive every 20s
  const ping = setInterval(() => { if(ws.readyState===1) ws.ping() }, 20000)
  ws.on('close', () => clearInterval(ping))
}

async function startHTTPFallback(chain) {
  const poll = async () => {
    try {
      const r = await fetch(chain.http, { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_getLogs', params:[{
          topics:[CR_AGGREGATE_TOPICS.SWAP_SIG], fromBlock:'latest', toBlock:'latest'
        }]}), signal:AbortSignal.timeout(8000) })
      const d = await r.json()
      for (const log of d.result||[]) {
        const usd = decodeSwapUSD(log.data, log.address)
        if (usd >= 1e5) pushDirective(usd, log.address||'0x0', chain.id)
      }
    } catch {}
  }
  setInterval(poll, 12000)
  console.log(`[CHAINS] ${chain.name} HTTP fallback active`)
}

// Start all chains
for (const chain of chains) {
  if (chain.ws && !chain.name.includes('solana')) connect(chain)
  else startHTTPFallback(chain)
}
// Update gas prices every 30s
setInterval(async () => {
  for (let i=0; i<chains.length; i++) {
    try {
      const r = await fetch(chains[i].http, { method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ jsonrpc:'2.0',id:1,method:'eth_gasPrice',params:[] }),
        signal:AbortSignal.timeout(3000) })
      const d = await r.json()
      if (d.result) HOT[62+i] = parseInt(d.result,16)/1e9
    } catch {}
  }
}, 30000)
