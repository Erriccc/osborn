// Usage: node scripts/sprite-exec.mjs <sprite-name> <cmd> [args...]
import { readFileSync } from 'fs'

const envFile = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const line = envFile.split('\n').find(l => l.startsWith('SPRITES_API_TOKEN='))
if (!line) { console.error('No SPRITES_API_TOKEN in .env.local'); process.exit(2) }
const TOKEN = line.slice('SPRITES_API_TOKEN='.length).replace(/^['"]|['"]$/g, '').trim()

const [, , sprite, cmd, ...args] = process.argv
if (!sprite || !cmd) { console.error('usage: sprite-exec <sprite> <cmd> [args...]'); process.exit(2) }

console.error(`[sprite-exec] ${sprite}: ${cmd} ${args.join(' ')}`)

const res = await fetch(`https://api.sprites.dev/v1/sprites/${sprite}/exec`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ cmd, args, timeout: 30 }),
})

console.error(`[sprite-exec] HTTP ${res.status}`)
if (!res.ok) { console.error(await res.text()); process.exit(1) }

const reader = res.body.getReader()
const dec = new TextDecoder()
let exitCode = 0
let frames = 0

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  if (!value || !value.length) continue
  frames++
  const sid = value[0]
  const payload = value.slice(1)
  if (sid === 0x01) process.stdout.write(dec.decode(payload))
  else if (sid === 0x02) process.stderr.write(dec.decode(payload))
  else if (sid === 0x03 && payload.length) exitCode = payload[0]
  else console.error(`[sprite-exec] unknown frame sid=0x${sid.toString(16)} len=${value.length}`)
}

console.error(`[sprite-exec] done, ${frames} chunks, exit=${exitCode}`)
process.exit(exitCode)
