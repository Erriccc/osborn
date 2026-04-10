// Tail the osborn service logs from the sprite — focus on the most recent
// boot to verify (a) we're running 0.8.8, (b) credentials file is picked up.

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

const r = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn/logs`, { headers: hdr })
console.log(`status: ${r.status}`)

const text = await r.text()
const lines = text.trim().split('\n')
console.log(`total log events: ${lines.length}\n`)

// Find the most recent osborn-bootstrap "Forcing upgrade" line — that marks
// the start of the 0.8.8 run.
let lastBootstrapIdx = -1
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes('Forcing upgrade to osborn@latest')) {
    lastBootstrapIdx = i
    break
  }
}

console.log(`=== logs from latest boot (idx ${lastBootstrapIdx} onwards) ===\n`)
const boot = lastBootstrapIdx >= 0 ? lines.slice(lastBootstrapIdx) : lines.slice(-100)
for (const l of boot) {
  try {
    const e = JSON.parse(l)
    const data = (e.data || '').trim()
    if (data) console.log(`  ${data}`)
  } catch {
    console.log(`  ${l}`)
  }
}

console.log('\n=== filter: credential / auth events ===')
for (const l of lines) {
  try {
    const e = JSON.parse(l)
    const d = e.data || ''
    if (/credential|auth|🔑|✅ Claude|Strip|redirect_uri|OAuth/.test(d)) {
      console.log(`  ${(d || '').trim()}`)
    }
  } catch {}
}
