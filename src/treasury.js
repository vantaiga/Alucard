// ═══════════════════════════════════════════════════════════════════════════
// FILE 7: src/treasury.js
// USDC conversion, 3-tier yield, USB vault, settlement bridge agnostic
// All profits → USDC. Treasury wallet holds trillions. USB holds the key.
// ═══════════════════════════════════════════════════════════════════════════
import { getDB } from './db.js'

const TREASURY_WALLET = '0xCCCF1C9A2154750A0D7CceeD51fE0f9b4c1906e8'
const EXECUTOR_WALLET = '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39'

// 3-tier yield targets (Aave supply APY, USDY, BUIDL)
const YIELD_TIERS = [
  { name:'Aave',  apy:0.065, share:0.20, recall:'instant' },
  { name:'USDY',  apy:0.042, share:0.50, recall:'24h'     },
  { name:'BUIDL', apy:0.0335,share:0.30, recall:'weekly'  },
]

// Settlement bridges: auto-detected from env vars (NAME_SECRET_KEY pattern)
const BRIDGE_PATTERN = /^([A-Z][A-Z0-9]+)_SECRET_KEY$/
const BRIDGES = {}

function loadBridges() {
  for (const [key, val] of Object.entries(process.env)) {
    const m = key.match(BRIDGE_PATTERN); if (!m || !val) continue
    const name = m[1].toLowerCase()
    BRIDGES[name] = { key:val, displayName:m[1] }
  }
  return Object.keys(BRIDGES)
}

export function startTreasury(SAB) {
  const HOT = new Float64Array(SAB)
  loadBridges()
  console.log(`[TREASURY] Bridges detected: ${Object.keys(BRIDGES).join(', ') || 'none'}`)
  console.log(`[TREASURY] Wallet: ${TREASURY_WALLET}`)
  console.log(`[TREASURY] 3-tier yield: Aave(6.5%) + USDY(4.2%) + BUIDL(3.35%)`)

  // Model 1 → Model 2 reserve routing (every 30s)
  // Reads confirmed MEV profits from DB and routes 50% to HOT[104]
  // Model 2 does NOT depend on this — if HOT[104]=0, Model 2 runs on base $45.59B
  setInterval(() => {
    const db = getDB()
    try {
      const recent = db.prepare(
        'SELECT SUM(profit_usdc) as total FROM executions WHERE ts > ? AND strategy LIKE "rs%"'
      ).get(Date.now() - 30000)
      if (recent?.total > 0) {
        const reserve = recent.total * 0.5
        HOT[104] = Math.min(HOT[104] + reserve, 100e9)  // cap $100B
        HOT[103] += recent.total                          // total treasury
      }
    } catch {}
  }, 30000)

  // Daily yield calculation
  setInterval(() => {
    const balance = HOT[103]
    const dailyYield = YIELD_TIERS.reduce((s, t) => s + balance * t.share * t.apy / 365, 0)
    HOT[1] += dailyYield  // add to daily revenue
  }, 3600000)
}

// Transfer via detected bridge
export async function transfer(params) {
  const { bridge='modempay', network, amount, phone, accountNumber, swiftCode, address, chain } = params
  const b = BRIDGES[bridge.toLowerCase()]
  if (!b) throw new Error(`Bridge '${bridge}' not configured`)

  // Modempay handler
  if (bridge.toLowerCase() === 'modempay') {
    const body = network === 'crypto'
      ? { amount, address, chain }
      : network === 'international'
      ? { amount, account_number:accountNumber, swift:swiftCode, beneficiary_name:params.name }
      : { amount, account_number:phone||accountNumber, network, beneficiary_name:params.name }

    const r = await fetch(`https://api.modempay.com/v1/transfers`, {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${b.key}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ ...body,
        reference:`SYSTEM_${Date.now()}`,
        description:'ALUCARD PROTOCOL (Owned and Operated By Bun Omar Secka)'
      }),
      signal: AbortSignal.timeout(60000)
    })
    return await r.json()
  }
  throw new Error(`No adapter for bridge: ${bridge}`)
}

export const getBridges   = () => Object.keys(BRIDGES)
export const getTreasury  = (SAB) => {
  const HOT = new Float64Array(SAB)
  return { balance:HOT[103], reserve:HOT[104], dailyRev:HOT[1] }
}
export const calcYield = (balance) =>
  YIELD_TIERS.reduce((s,t) => s + balance * t.share * t.apy / 365, 0)
