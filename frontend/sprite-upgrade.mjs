// Force-upgrade osborn on the cloud sandbox sprite to a specific pinned
// version, with the npm cache cleared and --prefer-online to bypass stale
// registry mirror data.
//
// Usage:
//   node sprite-upgrade.mjs              # uses pinned default below
//   OSBORN_VERSION=0.8.9 node sprite-upgrade.mjs
//
// Why pinned + --prefer-online: when we tested `osborn@latest` after a fresh
// publish, the sprite's npm pulled an old version because the registry mirror
// it talks to hadn't propagated yet. Pinning to an exact version + clearing
// the cache + forcing online forces the install to wait for the right data.
//
// The bootstrap also writes diagnostic info to /home/sprite/osborn-version.txt
// (host-readable via /fs/read) so we can verify what landed on disk after the
// service starts.

import { readFileSync } from 'node:fs'

const PINNED_OSBORN_VERSION = process.env.OSBORN_VERSION || '0.8.9'

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
const hdr = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

const envVars = {
  OSBORN_API_PORT: '8080',
  OSBORN_CWD: '/home/sprite/workspace',
  HOME: '/home/sprite',
  LIVEKIT_ROOM: 'osborn-e5a77be1',
}
for (const k of [
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
  'DEEPGRAM_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', 'SMITHERY_API_KEY', 'RECALL_API_KEY',
]) {
  const v = get(k)
  if (v) envVars[k] = v
}

const exportLines = Object.entries(envVars)
  .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
  .join('\n')

// Bootstrap: install + diagnostic dump + start
const bootstrap = `
set -e
export PATH="$(npm prefix -g)/bin:/.sprite/bin:\${PATH:-/usr/local/bin:/usr/bin:/bin}"
${exportLines}
mkdir -p /home/sprite/workspace

echo "[osborn-bootstrap] uninstalling old osborn first..."
npm uninstall -g osborn 2>&1 | tail -3 || true

echo "[osborn-bootstrap] clearing npm cache to bypass stale latest tag..."
npm cache clean --force 2>&1 | tail -2 || true

echo "[osborn-bootstrap] installing osborn@${PINNED_OSBORN_VERSION} (pinned, force-online)..."
npm install -g osborn@${PINNED_OSBORN_VERSION} @anthropic-ai/claude-code --prefer-online 2>&1 | tail -5
echo "[osborn-bootstrap] npm install exit=$?"

# Verify what npm actually installed — these print to the sprite service log
# so we can see the version in the log stream (since /fs/read of /home/sprite
# is service-private and doesn't reflect mid-bootstrap writes).
echo "[osborn-bootstrap] npm prefix -g: $(npm prefix -g 2>&1)"
echo "[osborn-bootstrap] which osborn: $(which osborn 2>&1)"
echo "[osborn-bootstrap] osborn binary realpath: $(readlink -f $(which osborn 2>&1) 2>&1)"
echo "[osborn-bootstrap] npm list -g osborn: $(npm list -g osborn 2>&1 | tail -3)"
# And probe the file directly — if the stripRedirectUri string is still in
# the installed claude-auth.js, npm pulled a pre-0.8.10 version and we need
# to investigate. If SENTINEL is in it, we have 0.8.10+.
OSBORN_PKG_DIR="$(npm root -g 2>/dev/null)/osborn"
if [ -d "$OSBORN_PKG_DIR" ]; then
  echo "[osborn-bootstrap] installed package dir: $OSBORN_PKG_DIR"
  echo "[osborn-bootstrap] installed version: $(grep \"version\" $OSBORN_PKG_DIR/package.json | head -1)"
  echo "[osborn-bootstrap] claude-auth.js has SENTINEL: $(grep -c SENTINEL $OSBORN_PKG_DIR/dist/claude-auth.js 2>&1)"
  echo "[osborn-bootstrap] claude-auth.js has stripRedirectUri: $(grep -c stripRedirectUri $OSBORN_PKG_DIR/dist/claude-auth.js 2>&1)"
fi

# Write diagnostic info to a file we can read via fs/read
{
  echo "=== osborn-version-check at $(date -u) ==="
  echo "PATH=$PATH"
  echo "which osborn: $(which osborn 2>&1)"
  echo "osborn binary target: $(readlink -f $(which osborn 2>&1) 2>&1)"
  echo "npm prefix -g: $(npm prefix -g)"
  echo ""
  echo "--- find osborn package.json ---"
  find / -maxdepth 6 -name package.json -path "*/osborn/*" 2>/dev/null | head -3
  echo ""
  for pkgjson in $(find / -maxdepth 6 -name package.json -path "*/osborn/*" 2>/dev/null); do
    echo "--- $pkgjson ---"
    grep -E '"version"|"name"' "$pkgjson" | head -3
  done
  echo ""
  echo "--- check claude-auth.js for stripRedirectUri ---"
  for js in $(find / -maxdepth 6 -name claude-auth.js -path "*/osborn/*" 2>/dev/null); do
    echo "found: $js"
    grep -c "stripRedirectUri" "$js" 2>&1
    grep "Stripped localhost" "$js" 2>&1 | head -1
  done
} > /home/sprite/osborn-version.txt 2>&1

echo "[osborn-bootstrap] wrote /home/sprite/osborn-version.txt"
echo "[osborn-bootstrap] starting osborn on port 8080..."
exec osborn
`.trim()

const serviceBody = {
  cmd: '/bin/bash',
  args: ['-c', bootstrap],
  needs: [],
  http_port: 8080,
}

async function consumeStream(res, label) {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      if (!p.trim()) continue
      try {
        const e = JSON.parse(p)
        console.log(`  [${label}] ${e.type}${e.data ? ': ' + e.data.substring(0, 120) : ''}`)
      } catch {}
    }
  }
}

async function main() {
  const start = Date.now()
  console.log(`=== UPGRADE+DIAG starting at ${new Date().toISOString()} ===\n`)

  console.log('Step 1: DELETE service')
  const del = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
  })
  console.log(`  status: ${del.status}`)
  try { await del.body?.cancel() } catch {}

  console.log('\nStep 2: PUT service')
  const put = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn`, {
    method: 'PUT', headers: hdr, body: JSON.stringify(serviceBody),
  })
  console.log(`  status: ${put.status}`)
  await consumeStream(put, 'PUT')

  console.log('\nStep 3: POST start')
  const startRes = await fetch(`${BASE}/v1/sprites/${SPRITE}/services/osborn/start`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
  })
  console.log(`  status: ${startRes.status}`)
  await consumeStream(startRes, 'START')

  console.log('\nStep 4: Poll /health')
  let healthy = false
  for (let i = 0; i < 90; i++) {
    try {
      const h = await fetch(`https://${SPRITE}-x745.sprites.app/health`, { signal: AbortSignal.timeout(4000) })
      if (h.ok) {
        console.log(`  health 200 after ${i + 1} attempts (${Math.floor((Date.now() - start) / 1000)}s)`)
        healthy = true
        break
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  if (!healthy) console.log('  HEALTH NEVER PASSED')

  // Step 5: Read the version-check file we wrote
  console.log('\nStep 5: read /home/sprite/osborn-version.txt')
  const vRes = await fetch(`${BASE}/v1/sprites/${SPRITE}/fs/read?path=${encodeURIComponent('/home/sprite/osborn-version.txt')}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  console.log(`  status: ${vRes.status}`)
  if (vRes.ok) {
    console.log('  ---')
    console.log((await vRes.text()).split('\n').map(l => '  ' + l).join('\n'))
  }

  // Step 6: probe /events
  console.log('\nStep 6: probe /events on running osborn')
  try {
    const ev = await fetch(`https://${SPRITE}-x745.sprites.app/events`, { signal: AbortSignal.timeout(4000) })
    console.log(`  /events: ${ev.status} ${ev.headers.get('content-type')}`)
    try { await ev.body?.cancel() } catch {}
  } catch (e) {
    console.log(`  /events: ${e.message}`)
  }

  console.log(`\n=== Done in ${Math.floor((Date.now() - start) / 1000)}s ===`)
}

main().catch(e => { console.error('ERROR:', e); process.exit(1) })
