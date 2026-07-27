// ═══════════════════════════════════════════════════════════════
// src/nexus.js — Worker Thread. <0.3ms routing. Pure SAB polling.
// Routes swap events to APEX with amplified profit estimates.
// ═══════════════════════════════════════════════════════════════
import { workerData }          from 'worker_threads'
import { amplify }             from './value_amplifier.js'
import { TOTAL_FLASH, getPropellerTarget } from './config.js'

const { SAB }    = workerData
const HOT        = new Float64Array(SAB)
const SIG_C2N    = new Int32Array(SAB, 4080)
const SIG_N2A    = new Int32Array(SAB, 4084)
const C2N_RING   = new Float64Array(SAB, 1024, 128)  // read from chains
const N2A_RING   = new Float64Array(SAB, 2048, 128)  // write to apex

let readHead  = 0
let writeHead = 0

function flashCap(lvl) {
  if(lvl<=1)  return  5e9; if(lvl<=5)  return 20e9
  if(lvl<=15) return 45.59e9; if(lvl<=25) return 80e9
  return 100e9
}

function route(slot) {
  const base    = (slot%64)*2
  const swapUSD = C2N_RING[base]
  if (!swapUSD) return

  const lvl     = HOT[0]
  const target  = getPropellerTarget(lvl)

  // Gate 1: daily ceiling (propeller governor — exact, not floor)
  if (HOT[1] >= target) return

  // Gate 2: flash available
  const flash = Math.min(HOT[2]+HOT[3], flashCap(lvl))
  if (flash < 1e8) return

  // Gate 3: amplified profit estimate
  const amp = amplify(swapUSD, flash, lvl)
  if (amp.totalProfit < 1000) return  // minimum $1K

  // Write to APEX ring
  const aSlot       = (writeHead%64)*2
  N2A_RING[aSlot]   = flash
  N2A_RING[aSlot+1] = amp.totalProfit

  // Log amplifier stats to SAB
  HOT[10] += amp.totalProfit - (swapUSD*0.001)  // amplifier bonus vs naive
  HOT[11] += amp.totalProfit                     // total amplified revenue

  Atomics.add(SIG_N2A, 0, 1)
  writeHead++
}

// Tight poll
function poll() {
  const head = Atomics.load(SIG_C2N, 0)
  while (readHead < head) { route(readHead); readHead++ }
  setImmediate(poll)
}

// Model 2 independent throughput (every block across all chains, no swap needed)
import { throughputAmplify } from './value_amplifier.js'
setInterval(()=>{
  const lvl    = HOT[0]
  const target = getPropellerTarget(lvl)
  if (HOT[1]>=target) return                // ceiling hit
  const flash  = Math.min(HOT[2]+HOT[3], flashCap(lvl))
  const amp    = throughputAmplify(flash, 1)
  if (amp.profit < 100) return
  // Write throughput opportunity to APEX
  const slot       = (writeHead%64)*2
  N2A_RING[slot]   = amp.flash
  N2A_RING[slot+1] = amp.profit
  Atomics.add(SIG_N2A,0,1)
  writeHead++
}, 250)  // every 250ms = ~4 per second throughput baseline

poll()
console.log('[NEXUS] Online — amplifier active, throughput loop running')
