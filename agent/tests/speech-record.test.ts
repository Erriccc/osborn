import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sp-'))
const { speechRecord, appendSpeechRecord } = await import('../src/speech-record.js')
const { readJsonlLines } = await import('../src/jsonl-sidecar.js')
const { getSidecarPath } = await import('../src/session-store.js')

const t = new Date('2026-01-01T00:00:00Z')
assert.deepEqual(speechRecord('heard', { messageId: 'm', heard: 'Hi.' }, t), { at: t.toISOString(), outcome: 'heard', messageId: 'm', heard: 'Hi.' })
const cut = speechRecord('cut', { heard: 'One', unheard: ' two three', estimate: true }, t)
assert.equal(cut.unheard, 'two three'); assert.equal(cut.estimate, true)
assert.equal('unheard' in speechRecord('heard', { heard: 'x', unheard: '  ' }, t), false, 'blank unheard is omitted')
assert.ok(speechRecord('held', { unheard: 'x'.repeat(5000) }, t).unheard!.length < 700, 'long text is capped')
appendSpeechRecord('s1', '/tmp/proj', cut)
appendSpeechRecord('s1', '/tmp/proj', speechRecord('stale', { unheard: 'z' }, t))
assert.deepEqual((readJsonlLines(getSidecarPath('s1', '/tmp/proj', 'speech.jsonl')) as any[]).map((r) => r.outcome), ['cut', 'stale'])
console.log('speech-record ok')
