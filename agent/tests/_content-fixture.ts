// Shared fixture for the content-pipeline Stage A blind tests (spec-derived; no real network/LLM spend).
// Builds a session.db + a REAL library page (via the existing runLibraryStep, fetch stubbed), then exposes a
// scripted fetch stub that records every OpenRouter chat call and every Supabase content_ingest POST.
// Assumption flagged in the report: the stub answers every Stage A prompt with a SUPERSET JSON reply
// (the real prompt/response schema is unknown to the blind author). Prompt routing is by keyword only.
import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import Database from 'better-sqlite3'

export const CLIENT = 'Zorbotron Industries'
export const SECRETS = {
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwbGFudGVkLXNlY3JldCIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.c2lnbmF0dXJlLXBsYW50ZWQtMTIzNDU2',
  fo1: 'fo1_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf',
}
export const DEV_LINE = 'We finally shipped the period library writer today'
export const ASSISTANT_LINE = 'The library writer is live and tested'

const H = 3_600_000
const T0 = Date.UTC(2026, 0, 1, 8, 0)
const iso = (h: number) => new Date(T0 + h * H).toISOString()
const seam = (w: string) => `<session_tail>\n2026-01-01T09:00  Assistant: replayed\n</session_tail>\n\n${w}`
export const ROWS: [string, string, number][] = [
  ['user', `Kick off the lens work for ${CLIENT} today`, 0],
  ['assistant', 'Starting the lens worker now', 1],
  ['user', 'Keep going with the worker please', 2],
  ['assistant', 'Worker is wired and logging', 5],
  ['user', seam('Right after compaction, back to the library'), 6],
  ['assistant', 'Picking the library up again', 6.2],
  ['user', seam('Compacted again already, keep going'), 6.5],
  ['user', DEV_LINE, 7],
  ['assistant', ASSISTANT_LINE, 9],
  ['user', 'Great, the index table looks right to me', 11],
  ['user', seam('New period: start on the ingest seam'), 12],
  ['assistant', 'Ingest stays a no-op for now', 13],
]

const words = (n: number, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(' ')

export interface Scenario {
  mode: 'ok' | 'http500' | 'throw' | 'garbage'
  costPerCall: number
  truthFlags: boolean
  /** extra narrator text injected into every generated script (redaction tests). */
  leak: string
  ingestStatus: number
  chat: { url: string; prompt: string }[]
  ingest: { url: string; body: string; payload: any }[]
}
export const newScenario = (): Scenario => ({ mode: 'ok', costPerCall: 0.001, truthFlags: false, leak: '', ingestStatus: 200, chat: [], ingest: [] })

const LIB_REPLY = JSON.stringify({
  high_leverage: [{ title: 'Period library writer shipped', why: 'one page per period, automatically', evidence: 'shipped', quotes: [{ row: 8, text: DEV_LINE }] }],
  period_goal: { text: 'Ship the automatic period library.', quotes: [{ row: 8, text: 'shipped the period library writer' }] },
  arc: [], what_worked: { held_up: [], didnt: [] },
  stories: [{ title: 'The library writer', why_it_matters: 'no manual runs', from_row: 8, to_row: 10, turning_points: [{ moment: 'index looks right', user_lines: [{ row: 10, text: 'the index table looks right to me' }] }] }],
  angles: [],
})

/** Superset reply for any generation prompt (brief / script / research). */
function genReply(s: Scenario) {
  const hi = {
    tier: 'highlight', kind: 'highlight', format: 'narrated-timeline', viewer: 'heavy Claude Code users who hit compaction',
    stake: { quantity: 'library pages per period', before: '0 pages', after: '1 page per period' },
    title: 'The day the period library shipped', hook: 'One page per period, automatically.', duration_s: 75, target_s: 75, causes: ['context is lost at compaction'], terms: ['compaction'],
    lines: [
      { speaker: 'narrator', voice: 'narrator', text: `${words(150)} ${s.leak}`.trim() },
      { speaker: 'dev', voice: 'dev', text: DEV_LINE, row: 8 },
      { speaker: 'narrator', voice: 'narrator', text: words(25) },
    ],
  }
  const how = {
    tier: 'howto', kind: 'howto', format: 'chat-replay', viewer: 'heavy Claude Code users who hit compaction',
    stake: { quantity: 'library pages per period', before: '0 pages', after: '1 page per period' },
    title: 'How to get one library page per period', hook: 'If compaction keeps eating your context.', duration_s: 150, target_s: 150, causes: ['context is lost at compaction'], terms: ['compaction'],
    lines: [
      { speaker: 'narrator', voice: 'narrator', text: `${words(330)} ${s.leak}`.trim() },
      { speaker: 'dev', voice: 'dev', text: DEV_LINE, row: 8 },
      { speaker: 'narrator', voice: 'narrator', text: words(30) },
    ],
  }
  const pieces = [hi, how]
  return { viewer: hi.viewer, audience: hi.viewer, situation: 'losing context at every compaction', topics: ['compaction'], brief: hi, briefs: pieces, scripts: pieces, pieces, script: hi, ...hi }
}

export function installFetch(s: Scenario) {
  let phase: 'library' | 'run' = 'library'
  const f = (async (url: any, init?: any) => {
    const u = String(url)
    if (u.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'minimax/minimax-m3', context_length: 1_048_576, pricing: { prompt: '0.0000003', completion: '0.0000012' } }] }), { status: 200 })
    }
    if (u.includes('/rest/v1/rpc/content_ingest')) {
      const body = String(init?.body ?? '')
      let payload: any = null
      try { payload = JSON.parse(body)?.p_payload } catch { /* */ }
      s.ingest.push({ url: u, body, payload })
      return new Response(JSON.stringify('11111111-2222-3333-4444-555555555555'), { status: s.ingestStatus })
    }
    if (u.includes('/chat/completions')) {
      const bodyTxt = String(init?.body ?? '')
      let prompt = bodyTxt
      try { prompt = (JSON.parse(bodyTxt).messages ?? []).map((m: any) => String(m.content)).join('\n') } catch { /* */ }
      if (phase === 'library') {
        return new Response(JSON.stringify({ choices: [{ message: { content: LIB_REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300, cost: 0.0012 }, provider: 'stub' }), { status: 200 })
      }
      s.chat.push({ url: u, prompt })
      if (s.mode === 'throw') throw new TypeError('network down (injected)')
      if (s.mode === 'http500') return new Response('upstream down', { status: 500 })
      let content: string
      if (s.mode === 'garbage') content = 'not json at all <<<'
      else if (/You write the spoken script|You write video briefs|You plan short developer videos/.test(prompt)) { const g: any = genReply(s); const how = /TIER: ~150s/.test(prompt); content = JSON.stringify(how ? { ...g, ...g.pieces[1] } : g) }
      else if (/truth|fact[- ]?check|unsupported claim|verify (every|each) claim/i.test(prompt)) {
        const flags = s.truthFlags ? [{ claim: 'The tool cut latency by 90%', reason: 'unsupported by the session library', severity: 'high' }] : []
        content = JSON.stringify({ flags, flagged: flags, unsupported: flags, issues: flags, ok: !s.truthFlags, pass: !s.truthFlags, passed: !s.truthFlags, verdict: s.truthFlags ? 'fail' : 'pass' })
      } else if (/audience check|is every quote or term (either )?already familiar|familiar to (them|the (target )?viewer)/i.test(prompt)) {
        content = JSON.stringify({ flags: [], issues: [], unfamiliar: [], ok: true, pass: true, passed: true, verdict: 'pass' })
      } else content = JSON.stringify(genReply(s))
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 400, cost: s.costPerCall }, provider: 'DeepInfra' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  globalThis.fetch = f
  return { toRun: () => { phase = 'run' }, toLibrary: () => { phase = 'library' } }
}

export interface Fixture {
  sessionId: string
  projectDir: string
  claudeDir: string
  dbPath: string
  denyPath: string
  libraryDir: string
  scenario: Scenario
  /** (re)apply this fixture's env; call before every run. */
  activate: (extra?: Record<string, string | undefined>) => void
  snapshot: () => string[]
}

const ENV_KEYS = ['OSBORN_CONTENT_PIPELINE', 'OSBORN_CONTENT_PERIOD_CAP_USD', 'OSBORN_CONTENT_DAY_CAP_USD', 'OSBORN_CONTENT_RENDER', 'OSBORN_CONTENT_MAX_PIECES', 'OSBORN_CONTENT_LENS', 'OSBORN_CONTENT_INGEST', 'OSBORN_LENS_MAX_COST_USD']

export async function makeFixture(name: string): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), `content-${name}-`))
  const claudeDir = join(tmp, 'claude')
  const denyPath = join(tmp, 'deny.json')
  writeFileSync(denyPath, JSON.stringify({ terms: { '[client]': [CLIENT] } }))
  const sessionId = `content-${name}-session-0001`
  const projectDir = join(claudeDir, 'projects', `-zz-content-${name}`)
  mkdirSync(join(projectDir, 'osb', sessionId), { recursive: true })
  const dbPath = join(projectDir, 'osb', sessionId, 'session.db')
  const scenario = newScenario()
  const base = (extra: Record<string, string | undefined> = {}) => {
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    process.env.OSBORN_LENS_DENYLIST = denyPath
    process.env.OPENROUTER_API_KEY = 'dummy-not-a-key'
    // The daily spend ledger is machine-scoped ($OSBORN_HOME or ~/.osborn): isolate it per fixture so tests never touch the real one.
    process.env.OSBORN_HOME = join(tmp, 'osborn-home')
    for (const k of ENV_KEYS) delete process.env[k]
    delete process.env.OSBORN_SYNC_TOKEN
    for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  const fx: Fixture = {
    sessionId, projectDir, claudeDir, dbPath, denyPath, libraryDir: '', scenario,
    activate: (extra = {}) => base({ OSBORN_SYNC_TOKEN: 'test-sync-token', ...extra }),
    snapshot: () => walk(projectDir).sort(),
  }
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE content(id INTEGER PRIMARY KEY, source TEXT, line_num INT, byte_offset INT, ts TEXT, msg_type TEXT, model TEXT, git_branch TEXT, cwd TEXT, tool_name TEXT, blob BLOB)`)
  for (const [type, text, h] of ROWS) db.prepare('INSERT INTO content(source, ts, msg_type, blob) VALUES (?,?,?,?)').run('main', iso(h), type, brotliCompressSync(Buffer.from(text)))
  db.close()

  // Real library page via the EXISTING step (stubbed LLM), so Stage A has genuine input.
  base()
  const ctl = installFetch(scenario)
  ctl.toLibrary()
  const { runLibraryStep } = await import('../src/content/lens-library.js')
  const r = await runLibraryStep({ sessionId, projectDir })
  if (r.status !== 'written') throw new Error(`fixture: library step status=${r.status} ${r.errors.join('; ')}`)
  fx.libraryDir = r.libraryDir!
  ctl.toRun()
  return fx
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(dir, rel))) {
    const p = join(rel, e)
    if (e === 'session.db' || e.startsWith('session.db-')) continue
    if (statSync(join(dir, p)).isDirectory()) out.push(...walk(dir, p))
    else out.push(`${p}:${statSync(join(dir, p)).size}`)
  }
  return out
}

/** Locate Stage A's entry point in a module namespace. ADAPTER: remap names in each test file's adapter block. */
export function pick(mod: Record<string, any>, names: string[], what: string): (...a: any[]) => any {
  for (const n of names) if (typeof mod[n] === 'function') return mod[n]
  throw new Error(`BLIND_REQUIRE_REAL: no export for ${what}; tried [${names.join(', ')}]; module exports [${Object.keys(mod).join(', ')}]`)
}

export const scriptPosts = (s: Scenario) => s.ingest.filter(i => i.payload && i.payload.source_kind !== 'library_page')
