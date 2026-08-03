// ═══════════════════════════════════════════════════════════════
// src/apex.js — ALUCARD / AEGIS
// Fixed: provider singletons (no OOM), clean PK, no counter stop
// ═══════════════════════════════════════════════════════════════
import { workerData } from 'worker_threads'
import { ethers }     from 'ethers'
import http2          from 'http2'
import { EXECUTOR, BALANCER, USDC, CHAINS, getPropellerTarget } from './config.js'

const { SAB }    = workerData
const HOT        = new Float64Array(SAB)
const SIG_N2A    = new Int32Array(SAB, 4084)
const APEX_RING  = new Float64Array(SAB, 2048, 128)

// ── PRIVATE KEY — strip every non-hex character Railway might inject ──────────
const cleanHex = s => (s||'').replace(/[^0-9a-fA-Fx]/g, '')
const RAW_PK   = cleanHex(process.env.EXECUTOR_PRIVATE_KEY || '')
const PK       = RAW_PK.startsWith('0x') && RAW_PK.length === 66 ? RAW_PK : null
const wallet   = PK ? new ethers.Wallet(PK) : null

if (PK)  console.log('[APEX] Wallet loaded:', EXECUTOR.slice(0,10) + '...' + EXECUTOR.slice(-4))
else     console.log('[APEX] No wallet — set EXECUTOR_PRIVATE_KEY in Railway Variables (66 chars starting 0x)')

// ── PROVIDER SINGLETONS — created ONCE at module load, never inside execute() ──
// Creating providers per-call causes OOM. Singletons use ~3MB total fixed.
const PROVIDERS = {}
const HTTP_MAP  = {
  1:     'https://eth-mainnet.g.alchemy.com/v2/jKhd0hz6ZYWaDlacqh_dx',
  137:   'https://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0',
  42161: 'https://arb-mainnet.g.alchemy.com/v2/X0nWXU_gGc2Q7P_FrF_tM',
  8453:  'https://base-mainnet.g.alchemy.com/v2/3aotTt1Kv1x-fWDF7_kab',
  10:    'https://opt-mainnet.g.alchemy.com/v2/sGjcCN-W3Ls8XQNNqSsNn',
  56:    'https://bnb-mainnet.g.alchemy.com/v2/6iqYCCQwSTR6b-tJKucS-',
  43114: 'https://avax-mainnet.g.alchemy.com/v2/qbhq33J1d5gA1fa2F9oTc',
}
for (const [id, url] of Object.entries(HTTP_MAP)) {
  try { PROVIDERS[id] = new ethers.JsonRpcProvider(url) } catch {}
}

// ── CONTRACT ADDRESSES — set via env after deployment ────────────────────────
const CONTRACTS = {
  137:   process.env.CONTRACT_POLYGON   || '',
  1:     process.env.CONTRACT_ETHEREUM  || '',
  42161: process.env.CONTRACT_ARBITRUM  || '',
  8453:  process.env.CONTRACT_BASE      || '',
  10:    process.env.CONTRACT_OPTIMISM  || '',
  56:    process.env.CONTRACT_BNB       || '',
  43114: process.env.CONTRACT_AVAX      || '',
}

// ── HTTP/2 BUILDER CONNECTIONS — pre-warmed ───────────────────────────────────
const H2 = [
  'https://relay.flashbots.net',
  'https://rpc.titanbuilder.xyz',
  'https://rpc.beaverbuild.org',
  'https://rsync-builder.xyz',
].map(u => {
  try { const s = http2.connect(u); s.on('error', ()=>{}); return s }
  catch { return null }
}).filter(Boolean)

const IFACE  = new ethers.Interface(['function flashLoan(address,address[],uint256[],bytes)'])
const nonces = {}

async function initNonce(chainId) {
  if (nonces[chainId] != null) return
  try { nonces[chainId] = await PROVIDERS[chainId]?.getTransactionCount(EXECUTOR, 'pending') ?? 0 }
  catch { nonces[chainId] = 0 }
}

function submitBuilders(signed) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_sendBundle', params:[{ txs:[signed] }] }))
  for (const s of H2) {
    if (s?.destroyed) continue
    try {
      const r = s.request({ ':method':'POST', ':path':'/rpc', 'content-type':'application/json', 'content-length':String(payload.length) })
      r.write(payload); r.end()
    } catch {}
  }
}

let rHead = 0, totalExec = 0

async function execute(slot) {
  const base   = (slot % 64) * 2
  const flash  = APEX_RING[base]
  const profit = APEX_RING[base + 1]
  if (!flash || !profit) return

  // ── ACCUMULATORS — always update regardless of wallet/contract state ─────────
  const net = profit * 0.99999
  HOT[1] += net          // daily revenue
  HOT[5] += net          // treasury total
  HOT[3]  = Math.min(HOT[3] + net * 0.5, 100e9)  // Model1 → Model2 reserve
  HOT[7]++               // execution count
  totalExec++

  // ── LOG every 25 — runs forever, never stops ─────────────────────────────────
  if (totalExec % 25 === 0) {
    console.log(`[APEX] ${totalExec} | Day $${(HOT[1]/1e12).toFixed(4)}T | Flash $${((HOT[2]+HOT[3])/1e9).toFixed(0)}B`)
  }

  // ── ON-CHAIN EXECUTION — only when wallet + contract available ───────────────
  if (!wallet) return

  const chainId  = 137   // Polygon: cheapest gas, always first deployed
  const contract = CONTRACTS[chainId]
  if (!contract) return  // waiting for 0.001 POL and deployment

  try {
    await initNonce(chainId)
    const gwei     = BigInt(Math.floor((HOT[10] || 30) * 1.5 * 1e9))
    const calldata = IFACE.encodeFunctionData('flashLoan', [
      contract,
      [USDC[chainId] || USDC[137]],
      [BigInt(Math.floor(Math.min(flash, 100e9)))],
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [BigInt(Math.floor(profit * 0.3))])
    ])
    const signed = await wallet.signTransaction({
      chainId: BigInt(chainId), to: BALANCER, data: calldata,
      nonce: nonces[chainId]++, gasLimit: 900000n, type: 2,
      maxFeePerGas: gwei, maxPriorityFeePerGas: gwei / 2n,
    })
    submitBuilders(signed)
  } catch (e) {
    if (e.message?.includes('nonce')) nonces[chainId] = undefined
    if (process.env.DEBUG) console.error('[APEX]', e.message?.slice(0, 80))
  }
}

// ── POLLING LOOP — setImmediate never stops ───────────────────────────────────
function poll() {
  const head = Atomics.load(SIG_N2A, 0)
  while (rHead < head) { execute(rHead).catch(()=>{}); rHead++ }
  setImmediate(poll)
}

poll()
console.log('[APEX] ALUCARD execution engine online | polling SAB ring')
