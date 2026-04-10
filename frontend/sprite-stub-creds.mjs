// Stub the credentials file on the sprite so ensureClaudeAuth() falls
// through to the OAuth flow. Use this before user-testing the auth fix.

import { readFileSync } from 'node:fs'

const ENV_PATH = '/Users/newupgrade/Desktop/Developer/osborn/frontend/.env.local'
const env = readFileSync(ENV_PATH, 'utf-8')
const get = (k) => {
  const line = env.split('\n').find(l => l.startsWith(k + '='))
  if (!line) return ''
  return line.slice(k.length + 1).trim().replace(/^"|"$/g, '')
}

const TOKEN = get('SPRITES_API_TOKEN')
const SPRITE = 'osborn-e5a77be1-2f1'
const BASE = 'https://api.sprites.dev'
const hdr = { Authorization: `Bearer ${TOKEN}` }

const p = '/home/sprite/.claude/.credentials.json'
const put = await fetch(`${BASE}/v1/sprites/${SPRITE}/fs/write?path=${encodeURIComponent(p)}`, {
  method: 'PUT',
  headers: { ...hdr, 'Content-Type': 'application/octet-stream' },
  body: '{}',
})
console.log(`PUT ${p}: ${put.status}`)

const r = await fetch(`${BASE}/v1/sprites/${SPRITE}/fs/read?path=${encodeURIComponent(p)}`, { headers: hdr })
console.log(`Read back: ${r.status}, body: ${r.ok ? await r.text() : ''}`)
