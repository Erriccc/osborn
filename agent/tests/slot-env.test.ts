// A background slot's subprocess gets no platform secrets, but keeps what it needs to run Claude.
// Run: npx tsx agent/tests/slot-env.test.ts
import assert from 'node:assert/strict'
import { buildSlotEnv, isSlotEnvDenied } from '../src/slot-manager.js'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

const base: Record<string, string | undefined> = {
  // secrets
  OSBORN_SYNC_TOKEN: 'sync',
  LIVEKIT_API_SECRET: 'lk-secret',
  LIVEKIT_API_KEY: 'lk-key',
  SUPABASE_SERVICE_ROLE_KEY: 'srk',
  SUPABASE_PERSONAL_ACCESS_TOKEN: 'pat',
  FLY_API_TOKEN: 'fly',
  FLY_API_TOKEN_1_Y: 'fly1',
  FLY_ORG_DEPLOY_TOKEN: 'fly2',
  SUPABASE_JWT_SECRET: 'jwt',
  PUSHOVER_TOKEN: 'po',
  PUSHOVER_USER_KEY: 'pu',
  NTFY_TOKEN: 'nt',
  SMITHERY_API_KEY: 'sm',
  WATCH_ACK_SECRET: 'w',
  SOME_PRIVATE_KEY: 'pk',
  // kept
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  ANTHROPIC_API_KEY: 'ant',
  OPENROUTER_API_KEY: 'or',
  OPENAI_API_KEY: 'oa',
  RECALL_API_KEY: 'rc',
  GITHUB_TOKEN: 'gh',
  GH_TOKEN: 'gh2',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  ANTHROPIC_BASE_URL: 'https://example.invalid',
  PATH: '/usr/bin',
  HOME: '/root',
  LIVEKIT_URL: 'wss://lk.invalid',
  UNDEF: undefined,
}

const env = buildSlotEnv(base)

t('platform secrets are stripped', () => {
  for (const k of ['OSBORN_SYNC_TOKEN', 'LIVEKIT_API_SECRET', 'LIVEKIT_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_PERSONAL_ACCESS_TOKEN', 'SUPABASE_JWT_SECRET', 'FLY_API_TOKEN', 'FLY_API_TOKEN_1_Y', 'FLY_ORG_DEPLOY_TOKEN',
    'PUSHOVER_TOKEN', 'PUSHOVER_USER_KEY', 'NTFY_TOKEN', 'SMITHERY_API_KEY']) {
    assert.equal(k in env, false, `${k} leaked into the slot env`)
  }
})

t('anything matching SECRET / PRIVATE_KEY (any case) is stripped', () => {
  for (const k of ['WATCH_ACK_SECRET', 'SOME_PRIVATE_KEY']) assert.equal(k in env, false, k)
  assert.equal(isSlotEnvDenied('x_secret_y'), true)
})

t('the Supabase public URL and anon key are kept', () => {
  assert.equal(env.SUPABASE_URL, 'https://x.supabase.co')
  assert.equal(env.SUPABASE_ANON_KEY, 'anon')
})

t('a GitHub token is kept (spokes keep one: local-hub-spoke-reasoner design)', () => {
  assert.equal(env.GITHUB_TOKEN, 'gh')
  assert.equal(env.GH_TOKEN, 'gh2')
})

t('model keys and the Claude OAuth token are kept', () => {
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth')
  assert.equal(env.ANTHROPIC_API_KEY, 'ant')
  assert.equal(env.OPENROUTER_API_KEY, 'or')
  assert.equal(env.OPENAI_API_KEY, 'oa')
  assert.equal(env.RECALL_API_KEY, 'rc', 'a user secret (USER_SECRET_KEYS) is kept')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.invalid')
})

t('ordinary env (PATH, HOME, non-secret config) is kept; undefined values are dropped', () => {
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/root')
  assert.equal(env.LIVEKIT_URL, 'wss://lk.invalid')
  assert.equal('UNDEF' in env, false)
})

t('IS_SANDBOX and CLAUDE_CODE_DISABLE_AUTO_MEMORY are always set', () => {
  assert.equal(env.IS_SANDBOX, '1')
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
  const bare = buildSlotEnv({})
  assert.equal(bare.IS_SANDBOX, '1')
  assert.equal(bare.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
})

t('the base env is not mutated', () => {
  assert.equal(base.LIVEKIT_API_SECRET, 'lk-secret')
  assert.equal('IS_SANDBOX' in base, false)
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
