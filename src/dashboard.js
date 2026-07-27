// ═══════════════════════════════════════════════════════════════
// src/dashboard.js — Express + WebSocket server. All 15+ tabs.
// Snapshot API, propeller API, settlement API, SOVEREIGN chat.
// ═══════════════════════════════════════════════════════════════
import express                  from 'express'
import { createServer }         from 'http'
import { WebSocketServer }      from 'ws'
import { fileURLToPath }        from 'url'
import { existsSync }           from 'fs'
import path                     from 'path'
import { getDB, getExecutions, exportSnapshot, recordTransfer, getTreasuryHistory } from './db.js'
import { getQueueSize }         from './overlay.js'
import { CHAINS, TOTAL_FLASH, TOTAL_CYCLES, getPropellerTarget } from './config.js'

const __dir = path.dirname(fileURLToPath(import.meta.url))

let SAB_REF=null, CHAINS_REF=[], ENV_REF={}
const app = express()
const srv = createServer(app)
const wss = new WebSocketServer({server:srv})

app.use(express.json())

// Serve Daybreak dashboard
app.get('/', (_,res)=>{
  const p=path.join(__dir,'../dashboard/daybreak.html')
  if(existsSync(p)) res.sendFile(p)
  else res.send('<h1>ALUCARD — Daybreak dashboard not found</h1><p>Place daybreak.html in /dashboard/</p>')
})

// Auth
const auth=(req,res,next)=>{
  const pin=req.headers['x-pin']||req.query.pin||req.body?.pin
  if(pin!==ENV_REF.PIN) return res.status(401).json({error:'Invalid PIN'})
  next()
}

// ── API ROUTES ─────────────────────────────────────────────────────────────────
app.get('/health',(_,res)=>{
  const HOT=new Float64Array(SAB_REF)
  res.json({ok:true,p:HOT[0],rev:HOT[1],chains:CHAINS_REF.length,mb:process.memoryUsage().heapUsed/1024/1024|0,uptime:HOT[8]|0})
})

app.get('/api/state',auth,(req,res)=>{
  const HOT=new Float64Array(SAB_REF)
  const chainCount=CHAINS_REF.length
  const p30=chainCount>0?(chainCount/20)*8.7e15:8.7e15
  res.json({
    propeller:HOT[0], dailyRevenue:HOT[1], target:getPropellerTarget(HOT[0]),
    crashSignal:HOT[4], treasury:HOT[5], flashBase:HOT[2], flashReserve:HOT[3],
    flashTotal:HOT[2]+HOT[3], amplifierBonus:HOT[10], totalAmplified:HOT[11],
    queueSize:getQueueSize(), executions:HOT[7], uptime:HOT[8],
    chainCount, activeChainsWS:CHAINS_REF.filter((_,i)=>HOT[40+i]>0).length,
    p30Dynamic:p30, totalCycles:TOTAL_CYCLES, memMB:process.memoryUsage().heapUsed/1024/1024|0,
    chains:CHAINS_REF.map((c,i)=>({name:c.name,id:c.id,active:!!HOT[40+i],gas:HOT[20+i]?.toFixed(2)})),
  })
})

app.post('/api/propeller',auth,(req,res)=>{
  const HOT=new Float64Array(SAB_REF)
  const {level}=req.body
  if(typeof level!=='number'||level<0||level>50) return res.status(400).json({error:'Level 0-50'})
  HOT[0]=level
  const p30=(CHAINS_REF.length/20)*8.7e15
  res.json({ok:true,level,target:getPropellerTarget(level),p30Dynamic:p30})
})

app.post('/api/sovereign/chat',auth,async(req,res)=>{
  // Forward to sovereign worker via stored reference
  res.json({response:`P${new Float64Array(SAB_REF)[0]} — SOVEREIGN online`,ts:Date.now()})
})

app.post('/api/sovereign/command',auth,(req,res)=>{
  const HOT=new Float64Array(SAB_REF)
  const{command}=req.body
  if(command==='halt')   {HOT[0]=0;  return res.json({ok:true,action:'halted'})}
  if(command==='crash')  {HOT[0]=50;HOT[4]=100;return res.json({ok:true,action:'crash_mode'})}
  if(command==='resume') {HOT[0]=5;  return res.json({ok:true,action:'resumed'})}
  res.status(400).json({error:'Unknown command'})
})

app.get('/api/executions',auth,(req,res)=>res.json(getExecutions(parseInt(req.query.limit)||100)))
app.get('/api/treasury',  auth,(req,res)=>res.json({history:getTreasuryHistory(50),balance:new Float64Array(SAB_REF)[5]}))
app.get('/api/queue',     auth,(req,res)=>res.json({size:getQueueSize()}))

// ── SETTLEMENT (bridge-agnostic) ──────────────────────────────────────────────
// Detects NAME_SECRET_KEY pattern from env
const BRIDGES={}
for(const[k,v]of Object.entries(process.env)){
  const m=k.match(/^([A-Z][A-Z0-9]+)_SECRET_KEY$/)
  if(m&&v) BRIDGES[m[1].toLowerCase()]={key:v,name:m[1]}
}

app.get('/api/bridges',auth,(_,res)=>res.json({bridges:Object.keys(BRIDGES)}))

app.post('/api/transfer',auth,async(req,res)=>{
  const{type,bridge='modempay',amount,phone,accountNumber,swiftCode,address,chain,name:bname}=req.body
  const b=BRIDGES[bridge?.toLowerCase()]
  if(!b) return res.status(400).json({error:`Bridge '${bridge}' not configured. Add ${bridge.toUpperCase()}_SECRET_KEY env var.`})
  const fees={wave:0.015,afrimoney:0.015,qmoney:0.015,bank:0.0125,international:0.0125,crypto:0.01}
  const network=type?.includes('mobile')?'wave':type?.includes('bank')?'bank':type?.includes('international')?'international':'crypto'
  const fee=(amount||0)*(fees[network]||0.015)
  try{
    const body={amount,currency:'GMD',account_number:phone||accountNumber||address,network,
      beneficiary_name:bname||'Recipient',reference:`ALUCARD_${Date.now()}`,
      description:'ALUCARD PROTOCOL (Owned and Operated By Bun Omar Secka)',swift:swiftCode}
    const r=await fetch('https://api.modempay.com/v1/transfers',{
      method:'POST',headers:{'Authorization':`Bearer ${b.key}`,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(60000)})
    const result=await r.json()
    if(!r.ok) return res.status(500).json({error:result.message||'Transfer failed'})
    recordTransfer({type,amount,bridge,recipient:phone||accountNumber||address,status:'submitted',reference:result.id||`REF_${Date.now()}`})
    res.json({ok:true,result,fee,net:amount-fee})
  }catch(e){res.status(500).json({error:e.message})}
})

app.get('/api/balance/:bridge',auth,async(req,res)=>{
  const b=BRIDGES[req.params.bridge]
  if(!b) return res.status(404).json({error:'Bridge not found'})
  try{const r=await fetch('https://api.modempay.com/v1/balances',{headers:{'Authorization':`Bearer ${b.key}`},signal:AbortSignal.timeout(10000)});res.json(await r.json())}
  catch(e){res.status(500).json({error:e.message})}
})

// ── SNAPSHOT / MIGRATION ──────────────────────────────────────────────────────
app.post('/api/system/snapshot',auth,(req,res)=>{
  try{const r=exportSnapshot();res.json({ok:true,...r,instruction:'Download snapshot.json and place in repo root for server migration.'})}
  catch(e){res.status(500).json({error:e.message})}
})
app.get('/api/system/snapshot/download',auth,(req,res)=>{
  const p=existsSync('/data/snapshot.json')?'/data/snapshot.json':existsSync('./data/snapshot.json')?'./data/snapshot.json':null
  if(!p) return res.status(404).json({error:'No snapshot. POST /api/system/snapshot first.'})
  res.download(p,'snapshot.json')
})

// ── WEBSOCKET — live state feed every 500ms ────────────────────────────────────
wss.on('connection',(ws,req)=>{
  const url=new URL(req.url||'/',`http://localhost`)
  if(url.searchParams.get('pin')!==ENV_REF.PIN){ws.close(4001,'Unauthorized');return}
  const HOT=new Float64Array(SAB_REF)
  const iv=setInterval(()=>{
    if(ws.readyState!==1){clearInterval(iv);return}
    try{ws.send(JSON.stringify({
      type:'state',ts:Date.now(),propeller:HOT[0],dailyRevenue:HOT[1],
      target:getPropellerTarget(HOT[0]),crashSignal:HOT[4],treasury:HOT[5],
      flashTotal:HOT[2]+HOT[3],amplifierBonus:HOT[10],
      queueSize:getQueueSize(),executions:HOT[7],uptime:HOT[8],
      chainCount:CHAINS_REF.length,activeChainsWS:CHAINS_REF.filter((_,i)=>HOT[40+i]>0).length,
      p30Dynamic:(CHAINS_REF.length/20)*8.7e15,
      memMB:process.memoryUsage().heapUsed/1024/1024|0,
    }))}catch{clearInterval(iv)}
  },500)
  ws.on('close',()=>clearInterval(iv))
})

export function startDashboard(SAB,chains,env){
  SAB_REF=SAB; CHAINS_REF=chains; ENV_REF=env
  srv.listen(env.PORT,()=>console.log(`[DASHBOARD] :${env.PORT} — PIN protected`))
}
