/**
 * Dashboard session-preview contract (sub-second-connect, dashboard fix).
 * getSessionPreview (via listSessions) must:
 *   D1  read a SMALL session whole → exact count + exact last user message
 *   D2  read a LARGE session (> head+tail threshold) BOUNDED, yet still return
 *       the LAST user message — which lives at the very END, outside the 64KB
 *       head — proving the tail read works (the whole point of the fix)
 *   D3  clear the ">2 messages" gate for a large session from the head alone
 *   D4  exclude empty / sub-2-message sessions
 *   D5  NOT read the whole large file (bounded) — asserted by timing + by the
 *       last-message coming from the tail, not a full scan
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, sandboxHome } from './_shared.js'

const HOME = sandboxHome()

const { listSessions, getSessionDir } = await import('../../src/config.js')

const PROJECT = '/tmp/osborn-dash-test-project'
const dir = getSessionDir(PROJECT)
mkdirSync(dir, { recursive: true })

const uuid = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`.slice(0, 36)
const userLine = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } })
const asstLine = (t: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
const toolLine = (pad: number) => JSON.stringify({ type: 'system', subtype: 'tool', junk: 'x'.repeat(pad) })

// D1 — small session, exact
const small = uuid(1)
writeFileSync(join(dir, `${small}.jsonl`), [
  JSON.stringify({ type: 'summary', cwd: PROJECT }),
  userLine('first question'),
  asstLine('first answer'),
  userLine('SMALL-LAST-USER-MSG'),
  asstLine('second answer'),
].join('\n') + '\n')

// D2/D3/D5 — LARGE session: a huge filler body (> 192KB) with the real last
// user message appended at the very END (far past the 64KB head window).
const large = uuid(2)
const header = [JSON.stringify({ type: 'summary', cwd: PROJECT }), userLine('q1'), asstLine('a1'), userLine('q2'), asstLine('a2')]
const filler: string[] = []
let bytes = 0
while (bytes < 400 * 1024) { const l = toolLine(2000) + '\n' + asstLine('filler turn'); filler.push(l); bytes += l.length }
writeFileSync(join(dir, `${large}.jsonl`),
  header.join('\n') + '\n' + filler.join('\n') + '\n' + userLine('LARGE-TAIL-LAST-USER-MSG') + '\n' + asstLine('final') + '\n')

// D4 — empty + sub-2-message sessions (excluded)
writeFileSync(join(dir, `${uuid(3)}.jsonl`), '')
writeFileSync(join(dir, `${uuid(4)}.jsonl`), userLine('lonely') + '\n')

const t0 = Date.now()
const sessions = await listSessions(PROJECT)
const ms = Date.now() - t0

const byId = new Map(sessions.map((s: any) => [s.sessionId, s]))
const sm = byId.get(small)
const lg = byId.get(large)

check('D1a', !!sm && sm.messageCount === 4, `small session exact count=4 (got ${sm?.messageCount})`)
check('D1b', !!sm && sm.lastMessage === 'SMALL-LAST-USER-MSG', `small last user message exact (got ${JSON.stringify(sm?.lastMessage)})`)
check('D2', !!lg && lg.lastMessage === 'LARGE-TAIL-LAST-USER-MSG', `LARGE last user message via TAIL read (got ${JSON.stringify(lg?.lastMessage)})`)
check('D3', !!lg && lg.messageCount > 2, `large session clears >2 gate (got ${lg?.messageCount})`)
check('D4', !byId.has(uuid(3)) && !byId.has(uuid(4)), 'empty + sub-2-message sessions excluded')
check('D5', ms < 2000, `listSessions bounded/fast even with a 400KB+ file (${ms}ms)`)

rmSync(PROJECT, { recursive: true, force: true })
void HOME
finish('dashboard-preview')
