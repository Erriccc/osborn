import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

/**
 * Cloud auth mint — create a Playwright storageState for the test account at
 * BOOT, from environment secrets (Fly secrets on the cloud engine):
 *
 *   OSBORN_TEST_EMAIL / OSBORN_TEST_PASSWORD  — the email/password account
 *   OSBORN_SUPABASE_URL / OSBORN_SUPABASE_ANON — the target app's Supabase
 *
 * Credentials live in SECRETS, never in the image (open-source-safe posture:
 * the shipped container stays guest-only unless the operator provides creds).
 * Same password-grant + @supabase/ssr cookie format as scripts/login-test-user.ts,
 * but env-driven and callable from the engine. Sessions are short-lived (~1h)
 * — irrelevant, since the engine mints fresh on every boot/wake.
 */
export async function mintProfileFromEnv(profilePath: string, appUrl: string): Promise<boolean> {
  const EMAIL = process.env.OSBORN_TEST_EMAIL
  const PASSWORD = process.env.OSBORN_TEST_PASSWORD
  const SUPABASE_URL = process.env.OSBORN_SUPABASE_URL
  const ANON = process.env.OSBORN_SUPABASE_ANON
  if (!EMAIL || !PASSWORD || !SUPABASE_URL || !ANON) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) { console.log(`[mint-profile] login failed ${res.status}`); return false }
    const session = await res.json()
    const REF = new URL(SUPABASE_URL).hostname.split('.')[0]
    const APP_HOST = new URL(appUrl).hostname
    const raw = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
    const CHUNK = 3180
    const name = `sb-${REF}-auth-token`
    const cookies: Array<Record<string, unknown>> = []
    if (raw.length <= CHUNK) cookies.push({ name, value: raw })
    else for (let i = 0; i * CHUNK < raw.length; i++) cookies.push({ name: `${name}.${i}`, value: raw.slice(i * CHUNK, (i + 1) * CHUNK) })
    const state = {
      cookies: cookies.map((c) => ({ ...c, domain: APP_HOST, path: '/', expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, httpOnly: false, secure: true, sameSite: 'Lax' })),
      origins: [{ origin: `https://${APP_HOST}`, localStorage: [{ name: 'osborn-connection-mode', value: 'cloud' }] }],
    }
    mkdirSync(dirname(profilePath), { recursive: true })
    writeFileSync(profilePath, JSON.stringify(state, null, 2))
    console.log(`[mint-profile] minted auth profile for ${session.user?.email} → ${profilePath}`)
    return true
  } catch (e) {
    console.log(`[mint-profile] failed: ${(e as Error).message}`)
    return false
  }
}
