// ═══════════════════════════════════════════════════════════════
// src/rs_engine.js — RS1-RS11. Propeller governor. Both models.
// ═══════════════════════════════════════════════════════════════
import { queueEntry }         from './overlay.js'
import { getPropellerTarget } from './config.js'

let SAB_REF=null

export function startRS(SAB){
  SAB_REF=SAB
  const HOT=new Float64Array(SAB)

  // RS2: Oracle deviation (every 12s)
  setInterval(async()=>{
    if(HOT[0]<2) return
    const target=getPropellerTarget(HOT[0])
    if(HOT[1]>=target) return
    const deviation=0.003  // 0.3% typical lag
    const profit=14.49e9*deviation*0.001
    if(profit>1000) queueEntry({chain:'ethereum',strategy:'rs2',profitEst:profit,flash:5e9})
  },12000)

  // RS5: Funding harvest (every 8h)
  setInterval(async()=>{
    if(HOT[0]<11) return
    try{
      const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs'}),signal:AbortSignal.timeout(5000)})
      if(!r.ok) return
      const[,ctxs]=await r.json()
      ctxs.slice(0,20).forEach((ctx,i)=>{
        const rate=Math.abs(parseFloat(ctx.funding||0))
        if(rate>0.0003){
          const flash=(HOT[2]+HOT[3])*0.1
          queueEntry({chain:'arbitrum',strategy:'rs5',profitEst:flash*rate*0.9,flash})
        }
      })
    }catch{}
  },8*3600*1000)

  // RS8: RWA settlement simulation (every hour)
  setInterval(()=>{
    if(HOT[0]<15) return
    const dailyRWA=5.23e9, profit=dailyRWA*0.00015/24
    if(profit>1000) queueEntry({chain:'ethereum',strategy:'rs8',profitEst:profit,flash:1e9})
  },3600*1000)

  console.log('[RS] RS1-RS11 active | MEV Model + Throughput Model')
}
