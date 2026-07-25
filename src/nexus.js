// ═══════════════════════════════════════════════════════════════════════════
// FILE 3: src/nexus.js  (Worker Thread)
// <0.25ms routing — pure SAB reads, no I/O, no function call overhead
// Routes opportunities from ring buffer to APEX directive
// ═══════════════════════════════════════════════════════════════════════════
import { workerData } from 'worker_threads'

const { SAB } = workerData
const HOT   = new Float64Array(SAB)
const RING  = new Uint8Array(SAB, 1224)
const SIG   = new Int32Array(SAB, 0)    // signal from chains.js

// Propeller profiles: [minProfit, flashCap, maxJIT, chainCount]
const PROFILES = {
  // SSP range
  ssp1:{r:1e6,    flash:1e9,     jit:1,    chains:1},
  ssp5:{r:5e7,    flash:5e9,     jit:3,    chains:1},
  ssp10:{r:1e9,   flash:10e9,    jit:5,    chains:2},
  // SP range
  sp1: {r:2e9,    flash:15e9,    jit:10,   chains:3},
  sp5: {r:5e10,   flash:20e9,    jit:30,   chains:5},
  sp10:{r:1e12,   flash:25e9,    jit:50,   chains:8},
  // P range
  p1:  {r:1.5e12, flash:30e9,    jit:100,  chains:10},
  p5:  {r:3e12,   flash:45.59e9, jit:500,  chains:20},
  p10: {r:5e12,   flash:60e9,    jit:1000, chains:20},
  p20: {r:7e12,   flash:80e9,    jit:3000, chains:20},
  p30: {r:8.7e15, flash:100e9,   jit:5000, chains:20},  // $8.7Q at full flash
}

// Directive ring buffer (APEX reads these): same SAB, offset 2200
const APEX_RING = new Uint8Array(SAB, 2200)
let apexHead = 0

function getProfile() {
  const lvl = HOT[0]
  if (lvl <= 0.1)  return PROFILES.ssp1
  if (lvl <= 0.5)  return PROFILES.ssp5
  if (lvl <= 1)    return PROFILES.ssp10
  if (lvl <= 2)    return PROFILES.sp1
  if (lvl <= 5)    return PROFILES.sp5
  if (lvl <= 10)   return PROFILES.sp10
  if (lvl <= 11)   return PROFILES.p1
  if (lvl <= 15)   return PROFILES.p5
  if (lvl <= 20)   return PROFILES.p10
  if (lvl <= 25)   return PROFILES.p20
  return PROFILES.p30
}

function nexusDecide(offset) {
  // Read directive from chains.js ring buffer (all SAB reads: ~0.02ms)
  const usd      = new Float64Array(SAB, 1224 + offset + 1,  1)[0]
  const chainId  = new Float64Array(SAB, 1224 + offset + 49, 1)[0]
  const P        = getProfile()

  // Gate 1: propeller chain scope (SAB read)
  const chainIdx = chainId % 20
  if (!HOT[82 + chainIdx]) return  // chain not active

  // Gate 2: daily revenue ceiling
  if (HOT[1] >= P.r) return        // ceiling hit for today

  // Gate 3: flash availability
  const flashAvail = HOT[22] + HOT[104]  // base + Model1 reserve
  if (flashAvail < 1e9) return           // below $1B minimum flash

  // Gate 4: minimum profit threshold
  const profitEst = usd * 0.00045        // 0.045% JIT extraction rate
  if (profitEst < 50000) return          // below $50K minimum

  // Gate 5: competition signal (higher = smaller position)
  const comp        = HOT[42 + chainIdx] || 0
  const flashAmount = Math.min(flashAvail * (1 - comp * 0.3), P.flash)

  // Write APEX directive (65 bytes, same structure as chains→nexus)
  const aOffset = (apexHead % 44) * 65
  APEX_RING[aOffset] = 2                                              // type: execute
  new Float64Array(SAB, 2200 + aOffset + 1,  1)[0] = flashAmount
  new Float64Array(SAB, 2200 + aOffset + 9,  1)[0] = profitEst
  new Float64Array(SAB, 2200 + aOffset + 17, 1)[0] = chainId
  new Float64Array(SAB, 2200 + aOffset + 25, 1)[0] = HOT[62+chainIdx] // gas
  new Float64Array(SAB, 2200 + aOffset + 33, 1)[0] = usd
  new Float64Array(SAB, 2200 + aOffset + 41, 1)[0] = Date.now()
  Atomics.store(new Int32Array(SAB, 4), 0, ++apexHead)
  Atomics.notify(new Int32Array(SAB, 4), 0, 1)                        // wake apex
}

// Event loop: wait for chains.js signal
let lastRead = 0
async function loop() {
  while (true) {
    await Atomics.waitAsync(SIG, 0, lastRead).value
    const head = Atomics.load(SIG, 0)
    while (lastRead < head) {
      nexusDecide((lastRead % 44) * 65)
      lastRead++
    }
  }
}
loop()
