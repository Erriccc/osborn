import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { speechRecord } from '../src/speech-record.js'
import { appendJsonlLine, readJsonlLines } from '../src/jsonl-sidecar.js'

const t = new Date('2026-01-01T00:00:00Z')
assert.deepEqual(speechRecord('heard', { messageId: 'm', heard: 'Hi.' }, t), { at: t.toISOString(), outcome: 'heard', messageId: 'm', heard: 'Hi.' })
const cut = speechRecord('cut', { heard: 'One', unheard: ' two three', estimate: true }, t)
assert.equal(cut.unheard, 'two three'); assert.equal(cut.estimate, true)
assert.equal('unheard' in speechRecord('heard', { heard: 'x', unheard: '  ' }, t), false, 'blank unheard is omitted')
assert.ok(speechRecord('held', { unheard: 'x'.repeat(5000) }, t).unheard!.length < 700, 'long text is capped')
const f = join(mkdtempSync(join(tmpdir(), 'sp-')), 'speech.jsonl')
appendJsonlLine(f, JSON.stringify(cut)); writeFileSync(f, JSON.stringify(cut) + '\n{torn')
appendJsonlLine(f, JSON.stringify(speechRecord('stale', { unheard: 'z' }, t)))
assert.deepEqual((readJsonlLines(f) as any[]).map((r) => r.outcome), ['cut', 'stale'])
console.log('speech-record ok')
