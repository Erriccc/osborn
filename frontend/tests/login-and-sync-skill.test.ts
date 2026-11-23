// /login offers only the email-code sign-in; the sync skill (v5) has the email-code option.
// npx tsx frontend/tests/login-and-sync-skill.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const login = readFileSync(new URL('../src/app/login/page.tsx', import.meta.url), 'utf8')
assert.ok(login.includes('<EmailOtpLogin supabase={supabase} />'), 'login offers EmailOtpLogin')
for (const bad of ['Continue with Google', 'Connect without account', 'signInWithOAuth', 'showEmailGate', 'demo-access']) {
  assert.ok(!login.includes(bad), `login no longer has ${bad}`)
}

async function main() {
const { GET } = await import('../src/app/api/sync-skill/route')
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.example.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-public-key'
const served = await (await GET()).text()
assert.match(served, /^Version: 5$/m)
assert.ok(served.includes('### Option B: sign in with an email code'))
assert.ok(served.includes('SUPABASE_URL=https://proj.example.supabase.co') && served.includes('ANON=anon-public-key'))
assert.ok(served.includes('/auth/v1/otp') && served.includes('create_user') && served.includes('/auth/v1/verify') && served.includes('/api/instance') && served.includes('chmod 600'))
assert.ok(!/service[_-]?role/i.test(served), 'no service-role key')

delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const bare = await (await GET()).text()
assert.ok(bare.includes('Not available from this copy') && !bare.includes('/auth/v1/otp'))

const seed = readFileSync(new URL('../../agent/.claude/skills/voice-native-sync/SKILL.md', import.meta.url), 'utf8')
assert.match(seed, /^Version: 5$/m)
const heads = (t: string) => ['## CREDENTIALS', '### Option A: paste from Settings', '### Option B: sign in with an email code', '## UPLOAD', '## DOWNLOAD']
for (const h of heads(seed)) assert.ok(seed.includes(h) && served.includes(h), h)
console.log('login-and-sync-skill: ok')
}
main().catch((e) => { console.error(e); process.exit(1) })
