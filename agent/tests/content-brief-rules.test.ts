// Brief STAKE rule wording follows OSBORN_CONTENT_STRICT. Run: npx tsx agent/tests/content-brief-rules.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.OSBORN_HOME = join(mkdtempSync(join(tmpdir(), 'brief-rules-test-')), 'osborn-home')
const { briefRules } = await import('../src/content/content-script-rules.js')

let pass = 0
const t = async (name: string, fn: () => unknown) => {
  try { await fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}
const stake = () => briefRules().find(r => r.startsWith('STAKE:'))!

await t('default mode: empty stake is flagged "no visible proof", not dropped', () => {
  delete process.env.OSBORN_CONTENT_STRICT
  assert.match(stake(), /flagged "no visible proof"/)
  assert.doesNotMatch(stake(), /will not be scripted/)
})

await t('strict mode: empty stake keeps the "will not be scripted" wording', () => {
  process.env.OSBORN_CONTENT_STRICT = '1'
  try {
    assert.match(stake(), /it will not be scripted\.$/)
    assert.doesNotMatch(stake(), /no visible proof/)
  } finally {
    delete process.env.OSBORN_CONTENT_STRICT
  }
})

console.log(`\n${pass} passed${process.exitCode ? ' (with failures)' : ''}`)
