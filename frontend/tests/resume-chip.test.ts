// Run: cd frontend && npx --yes tsx tests/resume-chip.test.ts
// Spec (bug 0e5479b6): "Resuming session..." is a transient status chip, not a
// transcript line. It clears on the first assistant message or after 30s. A
// re-resume updates the one existing chip (no second chip, timer restarts).
// It is never persisted (lives outside the message list); legacy transcript
// lines that look like it are recognised so they can be filtered.
import {
  RESUME_CHIP_TIMEOUT_MS, resumeChipReducer, resumeChipLabel, isResumeNoticeText,
  type ResumeChip,
} from '../src/lib/resume-chip'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const T0 = 1_000_000

t('timeout is 30s', () => eq(RESUME_CHIP_TIMEOUT_MS, 30_000, 'ms'))

t('start shows a chip', () => {
  const s = resumeChipReducer(null, { type: 'start', label: 'Resuming session…', now: T0 })
  eq(s, { label: 'Resuming session…', startedAt: T0 }, 'chip')
})

t('first assistant message clears it', () => {
  const s = resumeChipReducer({ label: 'x', startedAt: T0 }, { type: 'assistant' })
  eq(s, null, 'cleared')
})

t('assistant with no chip is a no-op (same identity)', () => {
  eq(resumeChipReducer(null, { type: 'assistant' }), null, 'null stays null')
})

t('tick before 30s keeps the same object (no re-render)', () => {
  const chip: ResumeChip = { label: 'x', startedAt: T0 }
  const s = resumeChipReducer(chip, { type: 'tick', now: T0 + 29_999 })
  ok(s === chip, 'identity kept')
})

t('tick at 30s clears it', () => {
  eq(resumeChipReducer({ label: 'x', startedAt: T0 }, { type: 'tick', now: T0 + 30_000 }), null, 'cleared')
})

t('re-resume updates the existing chip and restarts its timer', () => {
  let s = resumeChipReducer(null, { type: 'start', label: 'Resuming session…', now: T0 })
  s = resumeChipReducer(s, { type: 'start', label: 'Resuming session 1a2b3c4d…', now: T0 + 20_000 })
  eq(s, { label: 'Resuming session 1a2b3c4d…', startedAt: T0 + 20_000 }, 'one chip, new label, new start')
  eq(resumeChipReducer(s, { type: 'tick', now: T0 + 40_000 }), s, 'still shown 20s after the re-resume')
})

t('explicit clear (e.g. resume failed) removes it', () => {
  eq(resumeChipReducer({ label: 'x', startedAt: T0 }, { type: 'clear' }), null, 'cleared')
})

t('labels', () => {
  eq(resumeChipLabel(), 'Resuming session…', 'no id')
  eq(resumeChipLabel('1a2b3c4d-0000-1111-2222-333333333333'), 'Resuming session 1a2b3c4d…', 'with id')
  eq(resumeChipLabel(undefined, 'continue'), 'Continuing previous session…', 'continue')
})

t('legacy transcript lines are recognised', () => {
  ok(isResumeNoticeText('🔄 Resuming session...'), 'plain')
  ok(isResumeNoticeText('🔄 Resuming session 1a2b3c4d...'), 'with id')
  ok(isResumeNoticeText('🔄 Continuing previous session...'), 'continue')
  ok(isResumeNoticeText('Resuming session…'), 'ellipsis char')
  ok(!isResumeNoticeText('Resuming session work tomorrow is fine'), 'real speech')
  ok(!isResumeNoticeText('🔄 Switched to session (4 messages)'), 'switch summary is not the chip')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
