// ═══════════════════════════════════════════════════════════════
// src/sovereign.js — Worker Thread. AGI. 4 Laws. Learning. Chat.
// ═══════════════════════════════════════════════════════════════
import { workerData, parentPort } from 'worker_threads'
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { getPropellerTarget, CHAINS, TOTAL_FLASH, MEMORY_MB } from './config.js'

const { SAB } = workerData
const HOT     = new Float64Array(SAB)

const DATA  = existsSync('/data')?'/data':(mkdirSync('./data',{recursive:true}),'./data')
const SDAL  = `${DATA}/sdal.json`
let cfg = { p:5, mult:1.0, lastLearn:0 }
try { cfg={...cfg,...JSON.parse(readFileSync(SDAL,'utf8'))} } catch {}
const save = ()=>{ try{writeFileSync(SDAL,JSON.stringify(cfg))}catch{} }

// 4 LAWS
const LAWS = ['Capital protection — $1B/hr loss = emergency halt','Hit propeller target exactly — governor not floor','Operator commands override all SOVEREIGN decisions','Self-optimize continuously from every outcome']

parentPort?.on('message', msg=>{
  if(msg?.type==='chat') parentPort.postMessage({type:'chatReply',id:msg.id,response:chat(msg.msg||'')})
})

function chat(m) {
  const s = m.toLowerCase().trim()
  const pMatch = s.match(/p(?:ropeller)?\s*(\d+\.?\d*)/)
  if(pMatch){ const l=parseFloat(pMatch[1]); if(l>=0&&l<=50){HOT[0]=l;cfg.p=l;save();return `✓ Propeller → P${l}`} }
  if(/halt|stop/.test(s))   { HOT[0]=0;  return '⚠ Halted — P0' }
  if(/resume|start/.test(s)){ HOT[0]=cfg.p||5; return `✓ Resumed P${HOT[0]}` }
  if(/crash|p∞/.test(s))    { HOT[0]=50;HOT[4]=100; return '🔴 CRASH MODE — P50 all resources' }
  if(/status/.test(s))       return `P${HOT[0]} | $${(HOT[1]/1e12).toFixed(4)}T/day | Flash $${((HOT[2]+HOT[3])/1e9).toFixed(0)}B | ${HOT[7]|0} execs | ${HOT[8]/60|0}min uptime | Mem ${process.memoryUsage().heapUsed/1024/1024|0}MB`
  if(/laws/.test(s))         return LAWS.map((l,i)=>`LAW ${i+1}: ${l}`).join('\n')
  if(/chains/.test(s))       return `${CHAINS.length} chains | ${(CHAINS.filter((_,i)=>HOT[40+i]>0).length)} active WS | $${(TOTAL_FLASH/1e9).toFixed(1)}B flash`
  if(/amplifier/.test(s))    return `Amplifier bonus: $${(HOT[10]/1e6).toFixed(2)}M | Total amplified: $${(HOT[11]/1e12).toFixed(4)}T`
  return `SOVEREIGN P${HOT[0]} | $${(HOT[1]/1e12).toFixed(4)}T today | Commands: status, propeller N, halt, resume, crash, laws, chains, amplifier`
}

// Learning outcomes
const outcomes=[]
function learn(){
  if(outcomes.length<10) return
  const b=outcomes.splice(0,50)
  const avgErr=b.reduce((s,o)=>s+Math.abs((o.a-o.p)/(Math.abs(o.p)||1)),0)/b.length
  if(avgErr>0.05) cfg.mult=Math.max(0.7,cfg.mult*0.98)
  else if(avgErr<0.02) cfg.mult=Math.min(1.5,cfg.mult*1.01)
  cfg.lastLearn=Date.now(); save()
}

// Governance: 60s loop
async function govern(){
  while(true){
    await new Promise(r=>setTimeout(r,60000))
    try{
      // LAW 1
      if(HOT[1]<-1e9){HOT[0]=0;console.error('[SOVEREIGN] LAW 1: Emergency halt')}
      // LAW 2: pace
      const frac=(HOT[8]%86400)/86400, exp=getPropellerTarget(HOT[0])*frac
      if(HOT[1]<exp*0.80) cfg.mult=Math.min(1.5,cfg.mult*1.02)
      else if(HOT[1]>exp*1.02) cfg.mult=Math.max(0.5,cfg.mult*0.99)
      // Poll Hyperliquid for crash signal
      try{
        const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs'}),signal:AbortSignal.timeout(5000)})
        if(r.ok){const[,c]=await r.json();const max=Math.max(...c.slice(0,20).map(x=>Math.abs(parseFloat(x.funding||0))));HOT[4]=Math.min(max*5000,100)}
      }catch{}
      learn(); save()
    }catch(e){if(process.env.DEBUG)console.error('[SOVEREIGN]',e.message?.slice(0,50))}
  }
}

// Overnight review 3AM UTC
;(function sched(){const n=new Date(),nx=new Date();nx.setUTCHours(3,0,0,0);nx.setUTCDate(nx.getUTCDate()+1);setTimeout(()=>{learn();sched()},nx-n)})()

govern()
console.log('[SOVEREIGN] Online — 4 Laws active')
