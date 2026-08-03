// ═══════════════════════════════════════════════════════════════
// src/dashboard.js — ALUCARD + AEGIS (serves both)
// Fixed: PIN cleaned of all non-alphanumeric chars
// Fixed: WS rejection logged with exact PIN received vs expected
// Fixed: /ping endpoint (no auth) for connectivity check
// Broadcasts HOT data immediately — pre-deployment data is real
// ═══════════════════════════════════════════════════════════════
import { createRequire }    from 'module'
import { createServer }     from 'http'
import { existsSync }       from 'fs'
import { fileURLToPath }    from 'url'
import path                 from 'path'

const __dir  = path.dirname(fileURLToPath(import.meta.url))
const req    = createRequire(import.meta.url)
const express= req(path.join(__dir,'../node_modules/express'))
const { WebSocketServer } = req(path.join(__dir,'../node_modules/ws'))

import { getDB, getExecutions, exportSnapshot, recordTransfer, getTreasuryHistory } from './db.js'
import { getQueueSize }  from './overlay.js'
import { CHAINS, TOTAL_FLASH, TOTAL_CYCLES, getPropellerTarget, EXECUTOR, TREASURY } from './config.js'

let SAB_REF=null, CHAINS_REF=[], SOVEREIGN_W=null
const WS_CLIENTS   = new Set()
let   wsRejections = 0

// ── PIN CLEANER — strips quotes, newlines, spaces Railway may inject ──────────
const cleanPin = s => String(s||'').replace(/[^0-9a-zA-Z]/g,'')
const PIN      = cleanPin(process.env.DASHBOARD_PASSKEY || '3530588')

const app = express()
const srv  = createServer(app)
const wss  = new WebSocketServer({ server:srv, perMessageDeflate:false })
app.use(express.json({ limit:'1mb' }))

// Serve Daybreak (Alucard) at root, The Eye (Aegis) at /eye
app.get('/',    (_,res)=>{ const p=path.join(__dir,'../dashboard/daybreak.html'); existsSync(p)?res.sendFile(p):res.status(404).send('daybreak.html missing from /dashboard/') })
app.get('/eye', (_,res)=>{ const p=path.join(__dir,'../dashboard/eye.html');      existsSync(p)?res.sendFile(p):res.status(404).send('eye.html missing from /dashboard/') })
app.use(express.static(path.join(__dir,'../dashboard')))

// ── NO-AUTH — safe diagnostics ────────────────────────────────────────────────
app.get('/ping', (_,res)=>res.json({
  ok:true, ts:Date.now(),
  system:'ALUCARD/AEGIS',
  pin_length: PIN.length,
  ws_clients: WS_CLIENTS.size,
  ws_rejections: wsRejections,
  uptime: SAB_REF ? new Float64Array(SAB_REF)[8]|0 : 0,
}))
app.get('/health',(_,res)=>{
  const HOT=SAB_REF?new Float64Array(SAB_REF):null
  res.json({ok:true,uptime:HOT?HOT[8]|0:0,propeller:HOT?HOT[0]:0,rev:HOT?HOT[1]:0,chains:CHAINS_REF.length,mb:process.memoryUsage().heapUsed/1024/1024|0,wsClients:WS_CLIENTS.size})
})

// ── AUTH ──────────────────────────────────────────────────────────────────────
const auth=(req,res,next)=>{
  const p=cleanPin(req.headers['x-pin']||req.query.pin||req.body?.pin||'')
  if(p!==PIN)return res.status(401).json({error:'Invalid PIN'})
  next()
}

// ── STATE — pure HOT reads ────────────────────────────────────────────────────
function state(){
  if(!SAB_REF)return{type:'state',ts:Date.now(),error:'booting'}
  const HOT=new Float64Array(SAB_REF)
  const lvl=HOT[0], target=getPropellerTarget(lvl)
  const flash=HOT[2]+HOT[3]
  let qs=0; try{qs=getQueueSize()}catch{}
  return {
    type:'state', ts:Date.now(),
    propeller:lvl, target, dailyRevenue:HOT[1],
    revPct:target>0?Math.min(HOT[1]/target*100,100):0,
    flashBase:HOT[2], flashReserve:HOT[3], flashTotal:flash,
    amplifierBonus:HOT[10], totalAmplified:HOT[11],
    crashSignal:HOT[4], treasury:HOT[5], executions:HOT[7]|0,
    uptime:HOT[8]|0, v7Active:HOT[9]>0, queueSize:qs,
    chainCount:CHAINS_REF.length,
    activeWS:CHAINS_REF.filter((_,i)=>HOT[40+i]>0).length,
    chains:CHAINS_REF.map((c,i)=>({name:c.name,id:c.id,active:!!HOT[40+i],gas:HOT[20+i]?.toFixed(1)||'0'})),
    memMB:process.memoryUsage().heapUsed/1024/1024|0, memCap:120,
    executor:EXECUTOR, treasury_addr:TREASURY,
    p30Dynamic:(CHAINS_REF.length/20)*8.7e15,
    totalCycles:TOTAL_CYCLES,
  }
}

function broadcast(d){ const p=JSON.stringify(d); for(const ws of WS_CLIENTS){if(ws.readyState===1)try{ws.send(p)}catch{WS_CLIENTS.delete(ws)}} }
setInterval(()=>{ if(WS_CLIENTS.size>0) broadcast(state()) },500)

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
wss.on('connection',(ws,req)=>{
  let pin=''
  try{pin=cleanPin(new URL(req.url||'/','http://x').searchParams.get('pin')||'')}catch{}
  if(pin!==PIN){
    wsRejections++
    console.warn(`[DASHBOARD] WS REJECTED #${wsRejections} | got:'${pin}' expected:'${PIN}' | check DASHBOARD_PASSKEY env var`)
    ws.close(4001,'Unauthorized')
    return
  }
  WS_CLIENTS.add(ws)
  // Send immediately — no waiting for next 500ms tick
  ws.send(JSON.stringify(state()))
  ws.on('close',()=>WS_CLIENTS.delete(ws))
  ws.on('error',()=>WS_CLIENTS.delete(ws))
  ws.on('message',raw=>{
    try{
      const m=JSON.parse(raw.toString())
      if(m.type==='propeller'&&typeof m.level==='number'){
        const HOT=new Float64Array(SAB_REF); HOT[0]=m.level
        broadcast({type:'propeller',level:m.level,target:getPropellerTarget(m.level)})
      }
      if(m.type==='chat'&&m.message&&SOVEREIGN_W){
        const id=`chat_${Date.now()}`
        SOVEREIGN_W.postMessage({type:'chat',id,msg:m.message})
      }
    }catch{}
  })
  console.log(`[DASHBOARD] WS connected | clients:${WS_CLIENTS.size} | uptime:${new Float64Array(SAB_REF)[8]|0}s`)
})

// ── REST API ──────────────────────────────────────────────────────────────────
app.get('/api/state',         auth,(_,res)=>res.json(state()))
app.get('/api/executions',    auth,(req,res)=>{try{res.json(getExecutions(parseInt(req.query.limit)||100))}catch{res.json([])}})
app.get('/api/treasury',      auth,(_,res)=>{try{res.json({history:getTreasuryHistory(50),...state()})}catch{res.json({})}})
app.get('/api/queue',         auth,(_,res)=>res.json({size:getQueueSize()}))

app.post('/api/propeller',auth,(req,res)=>{
  const{level}=req.body
  if(typeof level!=='number'||level<0||level>50)return res.status(400).json({error:'Level 0-50'})
  const HOT=new Float64Array(SAB_REF); HOT[0]=level
  broadcast({type:'propeller',level,target:getPropellerTarget(level)})
  res.json({ok:true,level,target:getPropellerTarget(level)})
})

app.post('/api/command',auth,(req,res)=>{
  const HOT=new Float64Array(SAB_REF)
  const{command}=req.body
  if(command==='halt')  {HOT[0]=0;broadcast({type:'command',command:'halt'})}
  if(command==='crash') {HOT[0]=50;HOT[4]=100;broadcast({type:'command',command:'crash'})}
  if(command==='resume'){HOT[0]=parseFloat(process.env.DEFAULT_PROPELLER||'5')}
  res.json({ok:true,command})
})

app.post('/api/chat',auth,async(req,res)=>{
  const{message}=req.body; if(!message)return res.status(400).json({error:'No message'})
  try{
    const response=await new Promise((resolve,reject)=>{
      if(!SOVEREIGN_W)return reject(new Error('Sovereign not linked'))
      const id=`chat_${Date.now()}`
      const handler=msg=>{if(msg?.type==='chatReply'&&msg.id===id){SOVEREIGN_W.off('message',handler);resolve(msg.response)}}
      SOVEREIGN_W.on('message',handler)
      SOVEREIGN_W.postMessage({type:'chat',id,msg:message})
      setTimeout(()=>{SOVEREIGN_W.off('message',handler);reject(new Error('timeout'))},8000)
    })
    res.json({response,ts:Date.now()})
  }catch{res.json({response:`SOVEREIGN P${new Float64Array(SAB_REF)[0]} | uptime ${new Float64Array(SAB_REF)[8]|0}s`,ts:Date.now()})}
})

// Settlement bridges auto-detected from env vars
app.get('/api/bridges',auth,(_,res)=>{
  const bridges=[]
  for(const[k,v]of Object.entries(process.env)){if(k.match(/^[A-Z][A-Z0-9]+_SECRET_KEY$/)&&v)bridges.push(k.replace('_SECRET_KEY','').toLowerCase())}
  res.json({bridges})
})

app.post('/api/transfer',auth,async(req,res)=>{
  const{bridge='modempay',...params}=req.body
  try{
    const{send}=await import('./settlement.js')
    const result=await send(bridge,params)
    try{recordTransfer({type:params.type||'transfer',amount:params.amount||0,bridge,recipient:params.phone||params.accountNumber||params.address||'',status:'submitted',reference:result.reference||''})}catch{}
    res.json(result)
  }catch(e){res.status(500).json({error:e.message})}
})

app.post('/api/snapshot',auth,(_,res)=>{try{res.json({ok:true,...exportSnapshot()})}catch(e){res.status(500).json({error:e.message})}})
app.get('/api/snapshot/download',auth,(_,res)=>{
  const p=['/data/snapshot.json','./data/snapshot.json'].find(existsSync)
  if(!p)return res.status(404).json({error:'POST /api/snapshot first'})
  res.download(p,'snapshot.json')
})

export function startDashboard(SAB,chains,sovereignWorker){
  SAB_REF=SAB; CHAINS_REF=chains; SOVEREIGN_W=sovereignWorker||null
  if(SOVEREIGN_W){
    SOVEREIGN_W.on('message',msg=>{
      if(msg?.type==='chatReply') broadcast({type:'chatReply',response:msg.response,id:msg.id})
    })
  }
  const PORT=parseInt(process.env.PORT||'3000')
  srv.listen(PORT,()=>{
    console.log(`[DASHBOARD] :${PORT} | PIN:${PIN} | /ping to test | /health for status`)
    console.log(`[DASHBOARD] Daybreak: / | The Eye: /eye`)
  })
}
