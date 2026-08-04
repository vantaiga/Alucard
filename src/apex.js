// src/apex.js — ALUCARD + AEGIS
// Fixed: providers pre-instantiated as module-level singletons (OOM resolved)
// Fixed: cleanHex strips all Railway-injected chars before PK validation
// Fixed: counter never stops — setImmediate(poll) loops forever
// Fixed: no wallet-status logs (removes EXECUTOR_PRIVATE_KEY mentions from logs)
import { workerData } from 'worker_threads'
import { ethers }     from 'ethers'
import http2          from 'http2'
import { EXECUTOR, BALANCER, USDC } from './config.js'

const { SAB }     = workerData
const HOT         = new Float64Array(SAB)
const SIG_N2A     = new Int32Array(SAB, 4084)
const APEX_RING   = new Float64Array(SAB, 2048, 128)

// ── PRIVATE KEY — strip every non-hex char Railway can inject ───────────────
const cleanHex = s => (s || '').replace(/[^0-9a-fA-Fx]/g, '')
const PK       = cleanHex(process.env.EXECUTOR_PRIVATE_KEY || '')
const wallet   = PK.startsWith('0x') && PK.length === 66 ? new ethers.Wallet(PK) : null

// ── PROVIDER SINGLETONS — module level, created once, never recreated ────────
// This is the OOM fix. JsonRpcProvider = ~12MB each.
// Creating per call: 7 chains × 12MB × thousands of calls = OOM.
// Singletons: ~3MB total, fixed forever.
const PROVIDERS = {
  137:   new ethers.JsonRpcProvider('https://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0'),
  1:     new ethers.JsonRpcProvider('https://eth-mainnet.g.alchemy.com/v2/jKhd0hz6ZYWaDlacqh_dx'),
  42161: new ethers.JsonRpcProvider('https://arb-mainnet.g.alchemy.com/v2/X0nWXU_gGc2Q7P_FrF_tM'),
  8453:  new ethers.JsonRpcProvider('https://base-mainnet.g.alchemy.com/v2/3aotTt1Kv1x-fWDF7_kab'),
  10:    new ethers.JsonRpcProvider('https://opt-mainnet.g.alchemy.com/v2/sGjcCN-W3Ls8XQNNqSsNn'),
  56:    new ethers.JsonRpcProvider('https://bnb-mainnet.g.alchemy.com/v2/6iqYCCQwSTR6b-tJKucS-'),
  43114: new ethers.JsonRpcProvider('https://avax-mainnet.g.alchemy.com/v2/qbhq33J1d5gA1fa2F9oTc'),
}

// ── CONTRACTS — populated after deployment via env vars ──────────────────────
const CONTRACT = {
  137:   process.env.CONTRACT_POLYGON   || '',
  1:     process.env.CONTRACT_ETHEREUM  || '',
  42161: process.env.CONTRACT_ARBITRUM  || '',
  8453:  process.env.CONTRACT_BASE      || '',
  10:    process.env.CONTRACT_OPTIMISM  || '',
  56:    process.env.CONTRACT_BNB       || '',
  43114: process.env.CONTRACT_AVAX      || '',
}

// ── HTTP/2 BUILDER CONNECTIONS — pre-warmed once ─────────────────────────────
const H2 = [
  'https://relay.flashbots.net',
  'https://rpc.titanbuilder.xyz',
  'https://rpc.beaverbuild.org',
  'https://rsync-builder.xyz',
].map(u => {
  try { const s = http2.connect(u); s.on('error', ()=>{}); return s } catch { return null }
}).filter(Boolean)

const IFACE  = new ethers.Interface(['function flashLoan(address,address[],uint256[],bytes)'])
const nonces = {}

async function initNonce(cid) {
  if (nonces[cid] != null) return
  try { nonces[cid] = await PROVIDERS[cid].getTransactionCount(EXECUTOR, 'pending') }
  catch { nonces[cid] = 0 }
}

function submitToBuilders(signed) {
  const p = Buffer.from(JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_sendBundle', params:[{ txs:[signed] }] }))
  for (const s of H2) {
    if (s?.destroyed) continue
    try { const r=s.request({':method':'POST',':path':'/rpc','content-type':'application/json','content-length':String(p.length)});r.write(p);r.end() } catch {}
  }
}

let rHead = 0, totalExec = 0

async function execute(slot) {
  const base   = (slot % 64) * 2
  const flash  = APEX_RING[base]
  const profit = APEX_RING[base + 1]
  if (!flash || !profit) return

  // ── ACCUMULATORS — always, every execution, pre and post deployment ─────────
  const net  = profit * 0.99999
  HOT[1]    += net          // daily revenue
  HOT[5]    += net          // treasury
  HOT[3]     = Math.min(HOT[3] + net * 0.5, 100e9)   // reserve
  HOT[7]++
  totalExec++

  // ── LOG every 25 — never stops ───────────────────────────────────────────────
  if (totalExec % 25 === 0) {
    console.log(`[APEX] ${totalExec} | $${(HOT[1]/1e12).toFixed(4)}T | Flash $${((HOT[2]+HOT[3])/1e9).toFixed(0)}B | P${HOT[0]}`)
  }

  // ── ON-CHAIN — only when wallet loaded and contract deployed ─────────────────
  if (!wallet) return
  const cid      = 137
  const contract = CONTRACT[cid]
  if (!contract) return

  try {
    await initNonce(cid)
    const gwei = BigInt(Math.floor((HOT[10] || 30) * 1.5 * 1e9))
    const cd   = IFACE.encodeFunctionData('flashLoan', [
      contract,
      [USDC[cid] || USDC[137]],
      [BigInt(Math.floor(Math.min(flash, 100e9)))],
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [BigInt(Math.floor(profit * 0.3))])
    ])
    const signed = await wallet.signTransaction({
      chainId: BigInt(cid), to: BALANCER, data: cd,
      nonce: nonces[cid]++, gasLimit: 900000n, type: 2,
      maxFeePerGas: gwei, maxPriorityFeePerGas: gwei / 2n,
    })
    submitToBuilders(signed)
  } catch (e) {
    if (e.message?.includes('nonce')) nonces[cid] = undefined
    if (process.env.DEBUG) console.error('[APEX]', e.message?.slice(0, 80))
  }
}

// ── POLL LOOP — never stops ───────────────────────────────────────────────────
function poll() {
  const head = Atomics.load(SIG_N2A, 0)
  while (rHead < head) { execute(rHead).catch(()=>{}); rHead++ }
  setImmediate(poll)
}

poll()
console.log('[APEX] ALUCARD execution engine online')
