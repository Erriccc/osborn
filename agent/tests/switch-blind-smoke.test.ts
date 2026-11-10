// Run: npx tsx agent/tests/switch-blind-smoke.test.ts   (REAL SDK, OpenRouter fallback tier; costs a few tokens)
// A: new session, one message. Arm resume to B (copied into an isolated config dir). chat() again.
// Expect: init reports B, no session_resume_failed.
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { llm, initializeLogger } from '@livekit/agents'
initializeLogger({ pretty: false, level: 'warn' })

const realHome = process.env.HOME!
const B = process.env.SMOKE_B || 'bb215298-4e22-4f84-acd4-7feaddf8d08b'
const srcB = join(realHome, '.claude/projects/-workspace', B + '.jsonl')
// load ONLY the OpenRouter key, never print it
const KEYNAME = process.env.SMOKE_KEY || 'OPENROUTER_API_KEY'
const m = readFileSync('/workspace/osborn/.env', 'utf8').match(new RegExp('^' + KEYNAME + '=(.*)$', 'm'))
if (!m) { console.log('SKIP no ' + KEYNAME); process.exit(2) }
const home = mkdtempSync(join(tmpdir(), 'osb-smoke-'))
const proj = join(home, '.claude/projects/-workspace'); mkdirSync(proj, { recursive: true })
copyFileSync(srcB, join(proj, B + '.jsonl'))
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'Z_AI_PERSONAL_API_KEY', 'ZAI_API_KEY']) delete process.env[k]
process.env.HOME = home; process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
process.env[KEYNAME] = m[1].replace(/^["']|["']$/g, '').trim()

const { applyAuthFallback } = await import('../src/claude-auth.js')
const { ClaudeLLM } = await import('../src/claude-llm.js')
applyAuthFallback()
if (KEYNAME === 'ANTHROPIC_API_KEY') process.env.ANTHROPIC_MODEL = 'claude-haiku-5-5'
const l: any = new ClaudeLLM({ workingDirectory: '/workspace' })
const failed: any[] = []; l.events.on('session_resume_failed', (e: any) => failed.push(e))

async function turn(text: string) {
  const ctx = llm.ChatContext.empty(); ctx.addMessage({ role: 'user', content: text })
  const s = l.chat({ chatCtx: ctx }); let out = ''
  const to = setTimeout(() => { console.log('TIMEOUT'); process.exit(3) }, 150_000)
  for await (const c of s as any) { out += (c as any)?.delta?.content ?? ''; if (process.env.SMOKE_DEBUG) console.log('chunk', JSON.stringify(c).slice(0,120)) }
  clearTimeout(to); return out
}
const r1 = await turn('Reply with exactly the word: alpha')
const A = l.sessionId
console.log('turn1 done; A =', A, 'reply len', r1.length, 'spawnedResume=', l.spawnedResumeId)
l.setResumeSessionId(B)
console.log('armed B =', B, 'hasSession=', l.hasSession(), 'busy.idle=', l.busyState().idle)
const r2 = await turn('Reply with exactly the word: beta')
console.log('turn2 done; live sessionId =', l.sessionId, 'spawnedResume=', l.spawnedResumeId, 'reply len', r2.length)
console.log('session_resume_failed events:', JSON.stringify(failed))
const ok = A && A !== B && l.sessionId === B && failed.length === 0
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL'); l.closeSession?.(); process.exit(ok ? 0 : 1)
