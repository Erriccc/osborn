// Stage B: hammer sprite with /health every 5s for 120s, then stop and wait 45s.
// Checks LK room at each checkpoint to see if hibernation kills the connection
// while pings are active (it shouldn't if keepalive is the answer) and whether
// it dies once pings stop (it should if hibernation is the mechanism).

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
const ROOM = 'osborn-ydmuh8' // from Stage A
const BASE = 'https://api.sprites.dev'

const LK_URL = get('LIVEKIT_URL').replace('wss://', 'https://').replace('ws://', 'http://')
const svc = new RoomServiceClient(LK_URL, get('LIVEKIT_API_KEY'), get('LIVEKIT_API_SECRET'))

async function checkLk(label) {
  try {
    const rooms = await svc.listRooms([ROOM])
    if (rooms.length === 0) {
      console.log(`  ${label}  LK room=GONE`)
      return 0
    }
    const ps = await svc.listParticipants(ROOM)
    console.log(`  ${label}  LK room=alive, participants=${ps.length} (${ps.map(p => p.identity).join(',')})`)
    return ps.length
  } catch (e) {
    console.log(`  ${label}  LK error: ${e.message}`)
    return -1
  }
}

async function checkSpriteState(label) {
  try {
    const r = await fetch(`${BASE}/v1/sprites/${SPRITE}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    const d = await r.json()
    console.log(`  ${label}  sprite status=${d.status}, last_running_at=${d.last_running_at}`)
    return d.status
  } catch (e) {
    console.log(`  ${label}  sprite state error: ${e.message}`)
    return 'error'
  }
}

async function checkLogSize() {
  try {
    const r = await fetch(`${BASE}/v1/sprites/${SPRITE}/fs/read?path=%2Ftmp%2Fosborn-sprite.log`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    const text = await r.text()
    return text.length
  } catch {
    return -1
  }
}

async function ping() {
  try {
    const r = await fetch(`https://${SPRITE}-x745.sprites.app/health`, { signal: AbortSignal.timeout(4000) })
    return r.ok
  } catch {
    return false
  }
}

async function main() {
  const t0 = Date.now()
  const tag = () => `[T+${Math.floor((Date.now() - t0) / 1000).toString().padStart(3, '0')}s]`

  console.log(`=== HAMMER TEST starting at ${new Date().toISOString()} ===`)
  console.log(`Room: ${ROOM}, Sprite: ${SPRITE}`)
  console.log()

  console.log(`${tag()} BEFORE ping loop`)
  await checkLk(tag())
  await checkSpriteState(tag())
  const logSizeStart = await checkLogSize()
  console.log(`  ${tag()} log size=${logSizeStart}`)
  console.log()

  // Hammer phase: 120 seconds, ping every 5s
  console.log('--- HAMMER PHASE: /health every 5s for 120s ---')
  const hammerDurationMs = 120_000
  const hammerInterval = setInterval(ping, 5_000)
  const hammerEnd = Date.now() + hammerDurationMs

  // Checkpoints at T+30, T+60, T+90, T+120
  const checkpoints = [30, 60, 90, 120]
  for (const cp of checkpoints) {
    const targetT = t0 + cp * 1000
    while (Date.now() < targetT) await new Promise(r => setTimeout(r, 500))
    console.log(`${tag()} HAMMER checkpoint`)
    await checkLk(tag())
    await checkSpriteState(tag())
    const logSize = await checkLogSize()
    console.log(`  ${tag()} log size=${logSize} (delta=+${logSize - logSizeStart})`)
  }

  clearInterval(hammerInterval)
  console.log()
  console.log('--- IDLE PHASE: no more pings, wait 45s ---')

  // Idle phase: wait 45 seconds with no pings
  await new Promise(r => setTimeout(r, 45_000))
  console.log(`${tag()} IDLE final`)
  await checkLk(tag())
  await checkSpriteState(tag())
  const logSizeEnd = await checkLogSize()
  console.log(`  ${tag()} log size=${logSizeEnd} (delta=+${logSizeEnd - logSizeStart})`)

  console.log()
  console.log(`=== DONE in ${Math.floor((Date.now() - t0) / 1000)}s ===`)
}

main().catch(e => { console.error('ERROR:', e); process.exit(1) })
