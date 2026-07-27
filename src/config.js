// ═══════════════════════════════════════════════════════════════
// src/config.js  — SINGLE SOURCE OF TRUTH
// All hardcoded values. No env vars for operational config.
// Only 3 env vars ever needed: PORT, DASHBOARD_PASSKEY, MODEMPAY_SECRET_KEY
// ═══════════════════════════════════════════════════════════════
export const EXECUTOR  = '0xEc92EF0C897b48A3525Df011D08011c5eB2D6D39'
export const TREASURY  = '0xCCCF1C9A2154750A0D7CceeD51fE0f9b4c1906e8'
export const BALANCER  = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'
export const MC3       = '0xcA11bde05977b3631167028862bE2a173976CA11'
export const NFPM      = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'
export const SWAP_SIG  = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
export const MEMORY_MB = 120   // hard ceiling

// ── 20 ALCHEMY ENDPOINTS — HARDCODED ─────────────────────────────────────
export const ALCHEMY = {
  'eth-mainnet':        { http:'https://eth-mainnet.g.alchemy.com/v2/jKhd0hz6ZYWaDlacqh_dx',        id:1,       native:'ETH',  blocks:7200,   flashB:8200,  hasAave:true,  hasBal:true  },
  'arb-mainnet':        { http:'https://arb-mainnet.g.alchemy.com/v2/X0nWXU_gGc2Q7P_FrF_tM',        id:42161,   native:'ETH',  blocks:345600, flashB:2100,  hasAave:true,  hasBal:true  },
  'base-mainnet':       { http:'https://base-mainnet.g.alchemy.com/v2/3aotTt1Kv1x-fWDF7_kab',       id:8453,    native:'ETH',  blocks:43200,  flashB:1400,  hasAave:true,  hasBal:true  },
  'polygon-mainnet':    { http:'https://polygon-mainnet.g.alchemy.com/v2/CfWwmhym4lH5r7_T7_oU0',    id:137,     native:'POL',  blocks:40754,  flashB:1800,  hasAave:true,  hasBal:true  },
  'opt-mainnet':        { http:'https://opt-mainnet.g.alchemy.com/v2/sGjcCN-W3Ls8XQNNqSsNn',        id:10,      native:'ETH',  blocks:43200,  flashB:1100,  hasAave:true,  hasBal:true  },
  'bnb-mainnet':        { http:'https://bnb-mainnet.g.alchemy.com/v2/6iqYCCQwSTR6b-tJKucS-',        id:56,      native:'BNB',  blocks:28328,  flashB:1500,  hasAave:false, hasBal:true  },
  'avax-mainnet':       { http:'https://avax-mainnet.g.alchemy.com/v2/qbhq33J1d5gA1fa2F9oTc',       id:43114,   native:'AVAX', blocks:42146,  flashB:1200,  hasAave:true,  hasBal:true  },
  'blast-mainnet':      { http:'https://blast-mainnet.g.alchemy.com/v2/0zddkzYwBs_J7lTLPQJAr',      id:81457,   native:'ETH',  blocks:43200,  flashB:800,   hasAave:false, hasBal:true  },
  'zksync-mainnet':     { http:'https://zksync-mainnet.g.alchemy.com/v2/-2hgPK_0yIugOtz8gd2bN',     id:324,     native:'ETH',  blocks:43200,  flashB:900,   hasAave:false, hasBal:true  },
  'scroll-mainnet':     { http:'https://scroll-mainnet.g.alchemy.com/v2/2Hfl39Jdr3cIONf6P6evX',     id:534352,  native:'ETH',  blocks:28800,  flashB:600,   hasAave:false, hasBal:true  },
  'linea-mainnet':      { http:'https://linea-mainnet.g.alchemy.com/v2/1orEe9d1Y0Z6pcu0YsUPH',      id:59144,   native:'ETH',  blocks:43200,  flashB:700,   hasAave:false, hasBal:true  },
  'mantle-mainnet':     { http:'https://mantle-mainnet.g.alchemy.com/v2/TjtdcQ2UzexinqajRW1AX',     id:5000,    native:'MNT',  blocks:43200,  flashB:500,   hasAave:false, hasBal:true  },
  'gnosis-mainnet':     { http:'https://gnosis-mainnet.g.alchemy.com/v2/rcXlHBD_ATzcywKP_3yOv',     id:100,     native:'XDAI', blocks:16941,  flashB:400,   hasAave:false, hasBal:true  },
  'worldchain-mainnet': { http:'https://worldchain-mainnet.g.alchemy.com/v2/KYeP7PjTazpg9y1cESm3h', id:480,     native:'ETH',  blocks:43200,  flashB:300,   hasAave:false, hasBal:false },
  'berachain-mainnet':  { http:'https://berachain-mainnet.g.alchemy.com/v2/2dJONPcgoCkGLFULJ1ugZ',  id:80094,   native:'BERA', blocks:43200,  flashB:600,   hasAave:false, hasBal:false },
  'unichain-mainnet':   { http:'https://unichain-mainnet.g.alchemy.com/v2/oFFJFW-FxwGOnCaNx21LO',   id:1301,    native:'ETH',  blocks:43200,  flashB:500,   hasAave:false, hasBal:false },
  'sei-mainnet':        { http:'https://sei-mainnet.g.alchemy.com/v2/-vnNUoR-xYBdJc-EVAEtr',        id:1329,    native:'SEI',  blocks:345600, flashB:800,   hasAave:false, hasBal:false },
  'sonic-mainnet':      { http:'https://sonic-mainnet.g.alchemy.com/v2/bvVHqI4zTiNSN8Hkx9vqj',     id:146,     native:'S',    blocks:172800, flashB:700,   hasAave:false, hasBal:true  },
  'sonic-mainnet-2':    { http:'https://sonic-mainnet.g.alchemy.com/v2/OwN_yxTn0r3jg4KxlqkYJ',     id:146,     native:'S',    blocks:172800, flashB:700,   hasAave:false, hasBal:true  },
  'solana-mainnet':     { http:'https://solana-mainnet.g.alchemy.com/v2/FOimj4oVe521S4xNZC9FO',     id:0,       native:'SOL',  blocks:172800, flashB:1200,  hasAave:false, hasBal:false },
}

// Derived at import time
export const CHAINS      = Object.entries(ALCHEMY).map(([name,meta]) => ({
  name, ...meta,
  ws: meta.http.replace('https://','wss://'),
})).sort((a,b) => b.blocks - a.blocks)

export const TOTAL_FLASH = CHAINS.reduce((s,c) => s + c.flashB, 0) * 1e6   // ~45.59B
export const TOTAL_CYCLES = CHAINS.reduce((s,c) => s + c.blocks, 0)         // ~1.92M/day

// USDC addresses per chain id
export const USDC = {
  1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  137:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  10:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  56:    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
}

// Aave V3 pool addresses per chain id
export const AAVE = {
  1:     '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  137:   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  8453:  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  10:    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  43114: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
}

// Propeller table: level → daily revenue target (USD)
export const PROPELLER = {
  0.1:1e6, 0.2:2e6, 0.3:5e6, 0.4:10e6, 0.5:25e6,
  0.6:50e6, 0.7:100e6, 0.8:200e6, 0.9:500e6,
  1:1e9, 2:2e9, 3:5e9, 4:8e9, 5:10e9,          // SSP range (1B–10B)
  6:20e9, 7:50e9, 8:100e9, 9:200e9, 10:500e9,
  11:1.5e12, 12:2e12, 13:3e12, 14:4e12, 15:3e12,
  20:5e12, 25:7e12, 30:8.7e15, 50:9.18e18,
}

export function getPropellerTarget(lvl) {
  const levels = Object.keys(PROPELLER).map(Number).sort((a,b)=>a-b)
  const closest = levels.reduce((p,c) => Math.abs(c-lvl)<Math.abs(p-lvl)?c:p)
  return PROPELLER[closest]
}

// Pool addresses where token0 is the stable (use abs0/1e6 for USD)
export const STABLE0_POOLS = new Set([
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
  '0x45dda9cb7c25131df268515131f647d726f50608',
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b5',
  '0xc6962004f452be9203591991d15f6b388e09e8d0',
  '0x1fb3cf6e48f1e7b10213e7b6d87d4c073c7fdb7',
  '0x36696169c63e42cd08ce11f5deebbbcebae652050',
  '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8',
  '0x99ac8ca7087fa4a2a1fb6357269965a2014abc35',
])
