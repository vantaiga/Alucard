// src/modempay.js
// Standalone. Flawless transactions. Works with settlement.js or alone.
// Reference on every transaction: Alucard Operator: Bun Omar SECKA

const BASE_LIVE = 'https://api.modempay.com/v1'
const BASE_TEST = 'https://api.test.modempay.com/v1'
const REF       = 'Alucard Operator: Bun Omar SECKA'
const FEES      = { wave:0.015, afrimoney:0.015, qmoney:0.015, bank:0.0125, international:0.0125, crypto:0.01 }

function getKey()  { return (process.env.MODEMPAY_SECRET_KEY || '').trim().replace(/^["']|["']$/g,'') }
function isLive()  { return getKey().startsWith('sk_live_') }
function getBase() { return isLive() ? BASE_LIVE : BASE_TEST }
function configured() { const k=getKey(); return k.startsWith('sk_live_')||k.startsWith('sk_test_') }

// Rate limit tracker (100 req / 15 min)
const _calls = []
function checkRate() {
  const now=Date.now(), win=now-900000
  while(_calls.length && _calls[0]<win) _calls.shift()
  if(_calls.length>=95) throw new Error('ModemPay rate limit approaching (95/100 per 15min)')
  _calls.push(now)
}

async function call(method, endpoint, body) {
  checkRate()
  const key = getKey()
  if (!key) throw new Error('MODEMPAY_SECRET_KEY not set')
  const opts = {
    method,
    headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json', Accept:'application/json' },
    signal:AbortSignal.timeout(60000),
  }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(getBase() + endpoint, opts)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`ModemPay ${r.status}: ${data.message || data.error || JSON.stringify(data).slice(0,100)}`)
  return data
}

// ── CORE METHODS ──────────────────────────────────────────────────────────────
export const getBalance        = ()       => call('GET',  '/balances')
export const getTransferStatus = (id)     => call('GET',  `/transfers/${id}`)
export const listTransactions  = (n=20)   => call('GET',  `/transactions?limit=${n}`)
export const createPaymentIntent = (p)    => call('POST', '/payment-intents', p)

export async function transfer({ amount, currency='GMD', phone, name, network='wave', note='' }) {
  if (!amount || amount <= 0) throw new Error('Invalid amount')
  if (!phone)                  throw new Error('phone required')
  const reference = `${REF}${note?' | '+note:''}`.slice(0, 255)
  return call('POST', '/transfers', {
    amount, currency,
    account_number:   String(phone).trim(),
    network:          network.toLowerCase(),
    beneficiary_name: name || 'Recipient',
    reference,
    description:      reference,
  })
}

export function calcFee(amount, network='wave') {
  const rate = FEES[network.toLowerCase()] ?? 0.015
  return { amount, fee:+(amount*rate).toFixed(2), net:+(amount*(1-rate)).toFixed(2), rate:`${rate*100}%`, network }
}

export async function verifyWebhook(rawBody, sig) {
  const secret = process.env.MODEMPAY_WEBHOOK_SECRET
  if (!secret) return true
  const { createHmac } = await import('crypto')
  return sig === createHmac('sha512', secret).update(rawBody).digest('hex')
}

export function getStats() {
  const key = getKey()
  return {
    configured:  configured(),
    mode:        isLive() ? 'LIVE' : key.startsWith('sk_test_') ? 'TEST' : 'UNCONFIGURED',
    keyPrefix:   key ? key.slice(0,12)+'...' : 'NOT SET',
    base:        getBase(),
    callsWindow: _calls.length,
    rateLimit:   '100/15min',
    networks:    Object.keys(FEES),
    fees:        FEES,
    ref:         REF,
    note:        isLive()
      ? 'Key is LIVE. If dashboard shows pending: KYC review in progress at ModemPay.'
      : 'Using test key.',
  }
}

// Boot log
console.log(`[MODEMPAY] ${configured()?`${isLive()?'LIVE':'TEST'} | ${getKey().slice(0,12)}...`:'not configured'}`)
