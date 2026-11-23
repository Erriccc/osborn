// Follow-through (#378): the session-start recap (at most 3 lines, each item once, first
// prompt only) and what a session records per turn (origin, foreground only).
// Run: npx tsx agent/tests/loops-recap.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'loops-recap-test-'))
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
const cwd = join(home, 'proj')
mkdirSync(cwd, { recursive: true })
const L = await import('../src/loops-ledger.js')
const { readLastSession } = await import('../src/content/lens-paths.js')
const { createClaudeLLM } = await import('../src/claude-llm.js')

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}

function fileItems(sessionId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const id = L.loopIds.ask(`item ${sessionId} ${i}`)
    L.appendLoopRecord(sessionId, cwd, { kind: 'ask', id, text: `item ${i}`, source: 'explicit', origin: 'user_mic', fg: true })
    L.appendLoopRecord(sessionId, cwd, { kind: 'filed', id, url: `https://github.com/o/r/issues/${i + 1}`, at: `2026-11-0${i + 1}T00:00:00.000Z` })
  }
}

t('at most three filed items', () => {
  fileItems('s-old', 5)
  const lines = L.takeLoopsRecap(cwd)
  assert.equal(lines.length, 3)
  assert.match(lines[0].url, /issues\/5$/) // newest first
})

t('each recapped once', () => {
  const again = L.takeLoopsRecap(cwd)
  assert.equal(again.length, 2)
  assert.deepEqual(L.takeLoopsRecap(cwd), [])
})

t('injected on the first prompt after resume only', () => {
  fileItems('s-prev', 1)
  const llm: any = createClaudeLLM({ workingDirectory: cwd, followThrough: true })
  const first = llm.noteUserTurn('hello there', 's-now')
  assert.match(first, /FOLLOW-THROUGH RECAP/)
  assert.match(first, /issues\/1\)/)
  fileItems('s-prev2', 1)
  assert.equal(llm.noteUserTurn('second turn', 's-now'), '')
})

t('a background (non-foreground) session never recaps and its records are not fileable', () => {
  fileItems('s-prev3', 1)
  const bg: any = createClaudeLLM({ workingDirectory: cwd })
  assert.equal(bg.noteUserTurn('remind me to deploy tonight', 's-bg'), '')
  const rs = L.readLoopRecords('s-bg', cwd)
  assert.equal(L.openLoops(rs).length, 1)
  assert.equal(L.fileableLoops(rs).length, 0)
})

t('a meeting line and a phone line record a prompt but never an explicit ask', () => {
  const llm: any = createClaudeLLM({ workingDirectory: cwd, followThrough: true })
  llm.noteUserTurn('[MEETING — bot1]:\nAlice: remind me to send the deck', 's-meet')
  llm.setPhoneCall(true)
  llm.noteUserTurn('remind me to call the bank', 's-meet')
  const rs = L.readLoopRecords('s-meet', cwd)
  assert.deepEqual(rs.filter((r) => r.kind === 'prompt').map((r) => r.origin), ['meeting', 'phone'])
  assert.equal(rs.filter((r) => r.kind === 'ask').length, 0)
  assert.deepEqual(L.openLoops(rs), [])
})

t('the user\'s own mic prompt records an explicit ask for the foreground session', () => {
  const llm: any = createClaudeLLM({ workingDirectory: cwd, followThrough: true })
  llm.noteUserTurn('ok. Remind me to rotate the key.', 's-mic')
  const [item] = L.fileableLoops(L.readLoopRecords('s-mic', cwd))
  assert.equal(item.source, 'explicit')
  assert.equal(item.origin, 'user_mic')
  assert.equal(item.text, 'Remind me to rotate the key.')
  assert.equal(readLastSession()?.id, 's-mic')
})

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} passed`)
