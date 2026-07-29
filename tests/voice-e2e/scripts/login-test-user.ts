/**
 * Programmatic test-user login — no UI, no OAuth wall, no Mac needed.
 *
 * Signs in via Supabase's password grant (the test user created server-side,
 * routed to the main account's machine), then writes the session as the
 * @supabase/ssr cookie format into profiles/osbornojure/state.json — the
 * storageState every `profile: osbornojure` scenario already uses. Re-run
 * any time the session expires.
 *
 *   npx tsx scripts/login-test-user.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const feEnv = readFileSync('/Users/newupgrade/Desktop/Developer/osborn/frontend/.env.local', 'utf8')
const SUPABASE_URL = feEnv.match(/^NEXT_PUBLIC_SUPABASE_URL=(\S+)/m)![1]
const ANON = feEnv.match(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=(\S+)/m)![1]
const creds = readFileSync(join(__dirname, '..', 'profiles', 'test-user.env'), 'utf8')
const EMAIL = creds.match(/^TEST_USER_EMAIL=(\S+)/m)![1]
const PASSWORD = creds.match(/^TEST_USER_PASSWORD=(\S+)/m)![1]
const REF = new URL(SUPABASE_URL).hostname.split('.')[0]
const APP_HOST = new URL(process.env.OSBORN_APP_URL || 'https://www.voice-native.com').hostname

const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
if (!res.ok) throw new Error(`login failed ${res.status}: ${await res.text()}`)
const session = await res.json()
console.log(`✅ signed in as ${session.user?.email} (expires in ${session.expires_in}s)`)

// @supabase/ssr cookie format: sb-<ref>-auth-token = "base64-" + base64url(JSON),
// chunked into name.0, name.1... when longer than ~3180 chars.
const raw = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
const CHUNK = 3180
const name = `sb-${REF}-auth-token`
const cookies: any[] = []
if (raw.length <= CHUNK) {
  cookies.push({ name, value: raw })
} else {
  for (let i = 0; i * CHUNK < raw.length; i++)
    cookies.push({ name: `${name}.${i}`, value: raw.slice(i * CHUNK, (i + 1) * CHUNK) })
}
const state = {
  cookies: cookies.map((c) => ({
    ...c,
    domain: APP_HOST,
    path: '/',
    expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
  })),
  origins: [
    {
      origin: `https://${APP_HOST}`,
      localStorage: [
        // Land in cloud mode from first paint — fresh profiles default to
        // 'local', which probes localhost:8741, shows "Local (offline)", and
        // hides the account's real machine + recent conversations entirely
        // (observed: logged-in dashboard looked logged-out).
        { name: 'osborn-connection-mode', value: 'cloud' },
      ],
    },
  ],
}
// Which profile dir to write. Defaults to ozyjunks (the separate test account
// so the engine doesn't collide with your osbornojure usage — see session-engine
// OSBORN_TEST_PROFILE). Put that account's creds in profiles/test-user.env first.
const profileName = process.env.OSBORN_TEST_PROFILE || 'ozyjunks'
const out = join(__dirname, '..', 'profiles', profileName, 'state.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(state, null, 2))
console.log(`✅ storageState for '${profileName}' (${session.user?.email}) written to ${out} (${cookies.length} cookie chunk(s))`)
