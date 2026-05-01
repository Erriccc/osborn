// Read-only: fetch a file from the sprite filesystem via Sprites fs API.
// Does NOT restore checkpoints, does NOT modify anything. Pure GET.
//
// Usage: node scripts/sprite-fs-read.mjs <sprite-name> <remote-path>
import { readFileSync } from 'fs'

const envFile = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const line = envFile.split('\n').find(l => l.startsWith('SPRITES_API_TOKEN='))
const TOKEN = line.slice('SPRITES_API_TOKEN='.length).replace(/^['"]|['"]$/g, '').trim()

const [, , sprite, path] = process.argv
if (!sprite || !path) { console.error('usage: sprite-fs-read <sprite> <absolute-path>'); process.exit(2) }

// Try a few fs endpoint shapes — Sprites docs aren't checked in, probe what works.
const candidates = [
  `https://api.sprites.dev/v1/sprites/${sprite}/fs?path=${encodeURIComponent(path)}`,
  `https://api.sprites.dev/v1/sprites/${sprite}/files?path=${encodeURIComponent(path)}`,
  `https://api.sprites.dev/v1/sprites/${sprite}/fs/read?path=${encodeURIComponent(path)}`,
  `https://api.sprites.dev/v1/sprites/${sprite}/files${path}`,
  `https://api.sprites.dev/v1/sprites/${sprite}/fs${path}`,
]

for (const url of candidates) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(10000),
  }).catch(e => ({ ok: false, status: 0, statusText: e.message }))
  const ct = res.headers?.get?.('content-type') || ''
  console.error(`${res.status} ${url}   ct=${ct}`)
  if (res.ok) {
    const text = await res.text()
    process.stdout.write(text)
    process.exit(0)
  }
}
console.error('\nNo fs endpoint matched. Try `curl -H Auth: ... /v1/sprites/<name> -H "Accept: ..."` or check Sprites docs.')
process.exit(1)
