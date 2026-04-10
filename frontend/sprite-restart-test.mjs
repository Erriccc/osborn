// One-off: force a real osborn restart on the sprite and validate the
// keepalive+LiveKit hypothesis. Reads env from frontend/.env.local.

import { readFileSync } from 'node:fs'
import { RoomServiceClient } from 'livekit-server-sdk'

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

// Same shape as getPlatformEnvVars in sprites.ts
const envVars = {
  OSBORN_API_PORT: '8080',
  OSBORN_CWD: '/home/sprite/workspace',
  HOME: '/home/sprite',
  LIVEKIT_ROOM: 'osborn-e5a77be1', // first 8 chars of userId
}
for (const k of [
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
  'DEEPGRAM_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'SMITHERY_API_KEY', 'RECALL_API_KEY',
]) {
  const v = get(k)
  if (v) envVars[k] = v
}

// Replicate the reviewer's bootstrap script
const exportLines = Object.entries(envVars)
  .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
  .join('\n')

const bootstrap = `
set -e
export PATH="$(npm prefix -g)/bin:/.sprite/bin:\${PATH:-/usr/local/bin:/usr/bin:/bin}"
${exportLines}
mkdir -p /home/sprite/workspace

if ! command -v osborn >/dev/null 2>&1; then
  echo "[osborn-bootstrap] Installing osborn + claude-code..."
  npm install -g osborn@latest @anthropic-ai/claude-code
  echo "[osborn-bootstrap] Install complete"
fi

echo "[osborn-bootstrap] Starting osborn on port 8080..."
exec osborn >> /tmp/osborn-sprite.log 2>&1
`.trim()

const serviceBody = {
  cmd: '/bin/bash',
  args: ['-c', bootstrap],
  needs: [],
  http_port: 8080,
}

const hdr = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function consumeStream(res, label) {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let lines = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      if (!p.trim()) continue
      lines++
      try {
        const e = JSON.parse(p)
        console.log(`  [${label}] ${e.type}${e.data ? ': ' + e.data.substring(0, 80) : ''}`)
      } catch {}
    }
  }
  console.log(`  [${label}] stream ended (${lines} events)`)
}

async function main() {
  const start = Date.now()
  console.log(`=== RESTART TEST starting at ${new Date().toISOString()} ===\n`)

  // Step 1: DELETE existing service (kills frozen osborn)
  console.log('Step 1: DELETE service')
  const del = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
  })
  console.log(`  status: ${del.status}`)
  try { await del.body?.cancel() } catch {}

  // Step 2: PUT new service (fresh bootstrap, will start osborn cleanly)
  console.log('\nStep 2: PUT service (re-register)')
  const put = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn`, {
    method: 'PUT', headers: hdr, body: JSON.stringify(serviceBody),
  })
  console.log(`  status: ${put.status}`)
  await consumeStream(put, 'PUT')

  // Step 3: POST start
  console.log('\nStep 3: POST start')
  const startRes = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn/start`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
  })
  console.log(`  status: ${startRes.status}`)
  await consumeStream(startRes, 'START')

  // Step 4: Poll health until 200
  console.log('\nStep 4: Poll /health')
  let healthy = false
  for (let i = 0; i < 30; i++) {
    try {
      const h = await fetch(`https://${SPRITE}-x745.sprites.app/health`, { signal: AbortSignal.timeout(4000) })
      if (h.ok) {
        console.log(`  health 200 after ${i + 1} attempts (${Math.floor((Date.now() - start) / 1000)}s total)`)
        healthy = true
        break
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  if (!healthy) {
    console.log('  HEALTH NEVER PASSED — bailing')
    process.exit(1)
  }

  // Step 5: Tail osborn's log to get new room code
  console.log('\nStep 5: fetch log tail → extract room code')
  const logRes = await fetch(`${BASE}/v1/sprites/${SPRITE}/fs/read?path=%2Ftmp%2Fosborn-sprite.log`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const logText = await logRes.text()
  console.log('  log last 15 lines:')
  console.log(logText.split('\n').slice(-15).map(l => '    ' + l).join('\n'))

  const roomMatch = logText.match(/Connected to room: ([\w-]+)/g)
  const latestRoom = roomMatch ? roomMatch[roomMatch.length - 1].replace('Connected to room: ', '') : null
  console.log(`\n  latest room from log: ${latestRoom}`)

  // Step 6: Query LK — is the new room alive?
  console.log('\nStep 6: LiveKit room check')
  const LK_URL = get('LIVEKIT_URL').replace('wss://', 'https://').replace('ws://', 'http://')
  const svc = new RoomServiceClient(LK_URL, get('LIVEKIT_API_KEY'), get('LIVEKIT_API_SECRET'))
  if (latestRoom) {
    try {
      const rooms = await svc.listRooms([latestRoom])
      console.log(`  rooms matching ${latestRoom}:`, rooms.length)
      if (rooms.length > 0) {
        const ps = await svc.listParticipants(latestRoom)
        console.log(`  participants: ${ps.length}`)
        ps.forEach(p => console.log(`    - ${p.identity}`))
      }
    } catch (e) {
      console.log(`  listRooms error: ${e.message}`)
    }
  }

  console.log(`\n=== Stage A done in ${Math.floor((Date.now() - start) / 1000)}s ===`)
}

main().catch(e => { console.error('ERROR:', e); process.exit(1) })
