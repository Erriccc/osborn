// Run: cd frontend && npx tsx tests/room-view.test.ts
// Read-only room view (#383): broadcast events fold into rows; the page never sends.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyViewEvent, busyLabel, historyMessages, runTime, VIEW_ROW_CAP } from '../src/lib/room-view'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

t('user and assistant turns become rows; empty text and unknown types do nothing', () => {
  let rows = applyViewEvent([], { type: 'user_transcript', text: 'hi' })
  rows = applyViewEvent(rows, { type: 'assistant_response', text: 'hello', messageId: 'm1' })
  assert.deepEqual(rows.map((r) => [r.role, r.content]), [['user', 'hi'], ['assistant', 'hello']])
  assert.equal(applyViewEvent(rows, { type: 'assistant_response', text: '  ' }), rows)
  assert.equal(applyViewEvent(rows, { type: 'permission_request', toolName: 'Bash' }), rows)
  assert.equal(applyViewEvent(rows, null), rows)
})

t('a repeated assistant messageId is not added twice', () => {
  const rows = applyViewEvent([], { type: 'assistant_response', text: 'a', messageId: 'm1' })
  assert.equal(applyViewEvent(rows, { type: 'assistant_response', text: 'a', messageId: 'm1' }), rows)
})

t('a completed tool updates its running row in place', () => {
  let rows = applyViewEvent([], { type: 'tool_use', tool: 'Bash', status: 'running', command: 'npm test' })
  assert.equal(rows[0].toolMeta?.status, 'running')
  // The agent's completed event carries the same input (buildToolLogEvent), so the fields survive the merge.
  rows = applyViewEvent(rows, { type: 'tool_use', tool: 'Bash', status: 'completed', command: 'npm test' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].toolMeta?.status, 'completed')
  assert.equal(rows[0].toolMeta?.command, 'npm test')
})

t('rows are capped', () => {
  let rows: ReturnType<typeof applyViewEvent> = []
  for (let i = 0; i < VIEW_ROW_CAP + 20; i++) rows = applyViewEvent(rows, { type: 'user_transcript', text: `m${i}` })
  assert.equal(rows.length, VIEW_ROW_CAP)
  assert.equal(rows[rows.length - 1].content, `m${VIEW_ROW_CAP + 19}`)
})

t('history rows map roles and keep timestamps', () => {
  const rows = historyMessages([{ role: 'user', content: 'q', ts: '2026-11-20T10:00:00Z' }, { role: 'assistant', content: 'a' }])
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant'])
  assert.equal(rows[0].timestamp.toISOString(), '2026-11-20T10:00:00.000Z')
})

t('run time and busy label', () => {
  assert.equal(runTime(45_000), '45s')
  assert.equal(runTime(185_000), '3m 05s')
  assert.equal(runTime(3_720_000), '1h 02m')
  assert.equal(busyLabel({ turnInFlight: true, permissionPending: true }), 'Waiting for an approval in the session')
  assert.equal(busyLabel({}), null)
})

t('the view page never publishes or sends to the agent', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'view', 'page.tsx'), 'utf8')
  assert.doesNotMatch(page, /publishData|sendText|setMicrophoneEnabled|\/api\/token|method: 'POST'/)
  assert.match(page, /autoSubscribe: false/)
  assert.match(page, /view-token/)
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
