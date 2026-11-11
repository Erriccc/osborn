// Unit tests for the #86 Activity-log categoriser helpers.
// Run:  cd frontend && npx tsx src/lib/activityCategory.test.ts
//   (or, with Node 22+ type-stripping: node --experimental-strip-types src/lib/activityCategory.test.ts)

import assert from 'node:assert/strict'
import { categorizeTool, categoryStyle, stripResultMarkdown, type ActivityCategory } from './activityCategory'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

// --- categorizeTool ----------------------------------------------------------
check('categorizeTool maps shell to command', () => {
  assert.equal(categorizeTool('bash'), 'command')
  assert.equal(categorizeTool('Bash'), 'command')
  assert.equal(categorizeTool('  BASH  '), 'command')
})
check('categorizeTool maps file tools to file', () => {
  for (const t of ['read', 'write', 'edit', 'multiedit', 'notebookread', 'notebookedit', 'MultiEdit']) {
    assert.equal(categorizeTool(t), 'file', `${t} should be file`)
  }
})
check('categorizeTool maps grep/glob to search', () => {
  assert.equal(categorizeTool('grep'), 'search')
  assert.equal(categorizeTool('glob'), 'search')
})
check('categorizeTool maps web tools to web', () => {
  assert.equal(categorizeTool('webfetch'), 'web')
  assert.equal(categorizeTool('websearch'), 'web')
})
check('categorizeTool falls back to note for unknown/blank/nullish', () => {
  assert.equal(categorizeTool('task'), 'note')
  assert.equal(categorizeTool('SomeFutureTool'), 'note')
  assert.equal(categorizeTool(''), 'note')
  assert.equal(categorizeTool('   '), 'note')
  assert.equal(categorizeTool(undefined), 'note')
  assert.equal(categorizeTool(null), 'note')
})

// --- categoryStyle -----------------------------------------------------------
check('categoryStyle returns a label + classes for every category', () => {
  const cats: ActivityCategory[] = ['command', 'file', 'search', 'web', 'note']
  for (const c of cats) {
    const s = categoryStyle(c)
    assert.ok(s.label.length > 0, `${c} has a label`)
    assert.ok(s.chipClass.length > 0, `${c} has a chipClass`)
    assert.ok(s.dotClass.length > 0, `${c} has a dotClass`)
  }
  assert.equal(categoryStyle('command').label, 'Command')
  assert.equal(categoryStyle('file').label, 'File')
})

// --- stripResultMarkdown -----------------------------------------------------
check('stripResultMarkdown removes bold/italic emphasis markers', () => {
  assert.equal(stripResultMarkdown('**GATE: PASS**'), 'GATE: PASS')
  assert.equal(stripResultMarkdown('__done__'), 'done')
  assert.equal(stripResultMarkdown('Result: **GATE: NEEDS-MORE** on branch'), 'Result: GATE: NEEDS-MORE on branch')
})
check('stripResultMarkdown keeps verdict text intact and leaves bare asterisks in prose', () => {
  assert.equal(stripResultMarkdown('VERDICT: REJECT'), 'VERDICT: REJECT')
  // A lone asterisk that is not an emphasis pair must survive (e.g. "2 * 3").
  assert.equal(stripResultMarkdown('2 * 3 = 6'), '2 * 3 = 6')
})
check('stripResultMarkdown strips inline code, headers and bullets', () => {
  assert.equal(stripResultMarkdown('ran `npm test`'), 'ran npm test')
  assert.equal(stripResultMarkdown('# Summary'), 'Summary')
  assert.equal(stripResultMarkdown('- did a thing'), 'did a thing')
})
check('stripResultMarkdown handles empty/nullish and is trim-stable', () => {
  assert.equal(stripResultMarkdown(''), '')
  assert.equal(stripResultMarkdown(undefined), '')
  assert.equal(stripResultMarkdown(null), '')
  assert.equal(stripResultMarkdown('  hello  '), 'hello')
  // Idempotent: stripping already-clean text is a no-op.
  const clean = 'GATE: PASS on fix/duck-level-60'
  assert.equal(stripResultMarkdown(clean), clean)
})

console.log(`\n${passed} checks passed`)
