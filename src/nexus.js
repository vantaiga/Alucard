// src/nexus.js — REDRAFT: Worker Thread, SAB polling (not Atomics.waitAsync),
// routes opportunities to APEX ring buffer
import { workerData } from 'worker_threads'

const { SAB }    = workerData
const HOT        = new Float64Array(SAB)
const SIG        = new Int32Array(SAB)       // [0] = chains→nexus signal
const APEX_SIG   = new Int32Array(SAB, 8)   // [0] = nexus→apex signal (byte offset 8)

// Chains→Nexus ring buffer: SAB bytes 1024-2047 (64 slots × 16 bytes each)
// Each slot: [usd:f64][chainId:f64]  (16 bytes)
const CHAIN_RING  = new Float64Array(SAB, 1024, 128)  // 128 floats = 64 slots × 2
let   chainHead   = 0   // last read index from chains

// Nexus→Apex ring buffer: SAB bytes 2048-3071 (64 slots × 16 bytes each)
// Each slot: [flashAmount:f64][profitEst:f64]  (16 bytes)
const APEX_RING   = new Float64Array(SAB, 2048, 128)
let   apexWriteIdx = 0

// Propeller profiles (indexed by HOT[0])
function getFlashCap(level) {
  if (level <= 0.1)  return 1e9
  if (level <= 1)    return 5e9
  if (level <= 5)    return 15e9
  if (level <= 10)   return 25e9
  if (level <= 11)   return 30e9
  if (level <= 15)   return 45.59e9
  if (level <= 20)   return 60e9
  if (level <= 25)   return 80e9
  return 100e9   // P30: base $45.59B + Model1 reserve up to $100B total
}

function getDailyTarget(level) {
  if (level <= 0.1)  return 1e6
  if (level <= 0.5)  return 5e7
  if (level <= 1)    return 1e9
  if (level <= 5)    return 5e10
  if (level <= 10)   return 1e12
  if (level <= 11)   return 1.5e12
  if (level <= 15)   return 3e12
  if (level <= 20)   return 5e12
  if (level <= 25)   return 7e12
  return 8.7e15  // P30 = $8.7Q/day
}

// ── HOT DECISION (runs in tight loop, <0.1ms per call) ────────────────────────
function decide(slotIdx) {
  const base  = slotIdx * 2
  const usd   = CHAIN_RING[base]
  const chainId = CHAIN_RING[base + 1]
  if (!usd || !chainId) return

  const level  = HOT[0]
  const daily  = HOT[1]
  const target = getDailyTarget(level)

  // Gate 1: daily revenue ceiling
  if (daily >= target) return

  // Gate 2: minimum swap size (scales with propeller)
  const minSwap = level <= 5 ? 1e5 : level <= 15 ? 5e5 : 1e6
  if (usd < minSwap) return

  // Gate 3: flash available (base + Model1 reserve)
  const flashAvail = HOT[2] + HOT[3]
  const flashCap   = getFlashCap(level)
  const flash      = Math.min(flashAvail, flashCap)
  if (flash < 1e8) return  // minimum $100M flash

  // Profit estimate: 0.045% of flash (JIT extraction rate)
  const profitEst = flash * 0.00045

  // Gate 4: worthwhile?
  if (profitEst < 5000) return  // minimum $5K profit

  // Write APEX directive (ring buffer, no lock needed — single writer)
  const aBase = (apexWriteIdx % 64) * 2
  APEX_RING[aBase]     = flash
  APEX_RING[aBase + 1] = profitEst

  // Signal APEX via atomic increment
  Atomics.add(APEX_SIG, 0, 1)
  apexWriteIdx++
}

// ── POLLING LOOP (confirmed working on Railway — avoids Atomics.waitAsync hang) ──
// Polls chains ring buffer every ~0.1ms
let lastChainHead = 0
function poll() {
  const head = Atomics.load(SIG, 0)
  while (lastChainHead < head) {
    decide(lastChainHead % 64)
    lastChainHead++
  }
  setImmediate(poll)   // setImmediate = after I/O events, before next tick
}

poll()
console.log('[NEXUS] Online — SAB polling loop active')
