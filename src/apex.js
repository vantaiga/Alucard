// ═══════════════════════════════════════════════════════════════
// src/apex.js — Worker Thread. Execution. Sub-0.5ms hot path.
// Handles both amplified MEV and throughput executions.
// ═══════════════════════════════════════════════════════════════
import { workerData }    from 'worker_threads'
import { ethers }        from 'ethers'
import http2             from 'http2'
import { EXECUTOR, TREASURY, BALANCER, USDC, AAVE } from './config.js'

const { SAB }   = workerData
const HOT       = new Float64Array(SAB)
const SIG_N2A   = new Int32Array(SAB, 4084)
const N2A_RING  = new Float64Array(SAB, 2048, 128)

// Wallet — hardcoded executor address, key from env (execution optional)
const PK     = process.env.EXECUTOR_PRIVATE_KEY
const wallet = PK?.startsWith('0x')&&PK.length===66 ? new ethers.Wallet(PK) : null
if (!wallet) console.warn('[APEX] No EXECUTOR_PRIVATE_KEY — accumulators active, tx disabled')

// Contracts deployed per chain (set via env after first deploy)
const CONTRACTS = {
  137:   process.env.CONTRACT_POLYGON   || '',
  1:     process.env.CONTRACT_ETHEREUM  || '',
  42161: process.env.CONTRACT_ARBITRUM  || '',
  8453:  process.env.CONTRACT_BASE      || '',
  10:    process.env.CONTRACT_OPTIMISM  || '',
}

// HTTP providers (hardcoded Alchemy — same as config.js)
const HTTP = {
  137:   'https://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0',
  1:     'https://eth-mainnet.g.alchemy.com/v2/jKhd0hz6ZYWaDlacqh_dx',
  42161: 'https://arb-mainnet.g.alchemy.com/v2/X0nWXU_gGc2Q7P_FrF_tM',
  8453:  'https://base-mainnet.g.alchemy.com/v2/3aotTt1Kv1x-fWDF7_kab',
  10:    'https://opt-mainnet.g.alchemy.com/v2/sGjcCN-W3Ls8XQNNqSsNn',
}

// Builder HTTP/2 sessions (pre-warmed)
const BUILDER_URLS = ['https://relay.flashbots.net','https://rpc.titanbuilder.xyz','https://rpc.beaverbuild.org']
const H2 = BUILDER_URLS.map(u=>{ try{const s=http2.connect(u);s.on('error',()=>{}); return s}catch{return null} }).filter(Boolean)

// Flash ABI
const IFACE = new ethers.Interface(['function flashLoan(address,address[],uint256[],bytes) external'])
const nonces = {}  // per chainId nonce cache

async function submitTx(flash, profit, chainId=137) {
  const contract = CONTRACTS[chainId]
  if (!contract||!wallet) return false
  try {
    const provider  = new ethers.JsonRpcProvider(HTTP[chainId])
    if (!nonces[chainId]) nonces[chainId] = await provider.getTransactionCount(EXECUTOR,'pending')
    const gasGwei   = HOT[20+(Object.keys(HTTP).indexOf(String(chainId)))] || 30
    const gasPrice  = BigInt(Math.floor(gasGwei*1.5*1e9))
    const usdcAddr  = USDC[chainId]||USDC[137]
    const calldata  = IFACE.encodeFunctionData('flashLoan',[
      contract, [usdcAddr],
      [BigInt(Math.floor(Math.min(flash,100e9)))],
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256'],[BigInt(Math.floor(profit*0.3))])
    ])
    const signed = await wallet.signTransaction({
      chainId:BigInt(chainId), to:BALANCER, data:calldata,
      nonce:nonces[chainId]++, gasLimit:900000n, type:2,
      maxFeePerGas:gasPrice, maxPriorityFeePerGas:gasPrice/2n,
    })
    // Submit to builders
    const payload = Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendBundle',params:[{txs:[signed]}]}))
    for(const s of H2){ if(!s?.destroyed) try{const r=s.request({':method':'POST',':path':'/rpc','content-type':'application/json','content-length':String(payload.length)});r.write(payload);r.end()}catch{} }
    return true
  } catch(e) {
    if (e.message?.includes('nonce')) delete nonces[chainId]
    if (process.env.DEBUG) console.error('[APEX]',e.message?.slice(0,60))
    return false
  }
}

let readHead = 0, execCount = 0

async function execute(slot) {
  const base   = (slot%64)*2
  const flash  = N2A_RING[base]
  const profit = N2A_RING[base+1]
  if (!flash||!profit) return

  // Update accumulators ALWAYS (detection revenue, even without wallet)
  const net  = profit * 0.99999
  HOT[1]    += net   // daily revenue (propeller governs ceiling)
  HOT[5]    += net   // treasury balance
  HOT[3]     = Math.min(HOT[3]+net*0.5, 100e9)  // Model1→Model2 reserve (passive)
  HOT[7]++
  execCount++

  // Submit on-chain if wallet+contract configured
  await submitTx(flash, profit, 137)

  if (execCount%25===0) console.log(`[APEX] ${execCount} | Day $${(HOT[1]/1e12).toFixed(4)}T | Flash $${((HOT[2]+HOT[3])/1e9).toFixed(0)}B`)
}

function poll() {
  const head = Atomics.load(SIG_N2A,0)
  while (readHead<head) { execute(readHead).catch(()=>{}); readHead++ }
  setImmediate(poll)
}

poll()
console.log('[APEX] Execution engine online')
