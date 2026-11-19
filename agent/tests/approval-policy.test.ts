// Approval policy (#363, #364): request descriptions, the phone prompt and the
// session always-allow list.
// Run: npx tsx agent/tests/approval-policy.test.ts
import assert from 'node:assert/strict'
import {
  describePermission,
  isAlwaysAllowed,
  newSessionAllows,
  phoneApprovalPrompt,
  recordAlwaysAllow,
  speakablePermission,
} from '../src/approval-policy.js'

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) } catch (e: any) { console.log('FAIL ', name, '\n     ', e.message.split('\n')[0]); process.exitCode = 1 }
}

t('describePermission keeps the browser card wording', () => {
  assert.equal(describePermission('Bash', { command: 'npm test' }), 'I want to run the command: npm test')
  assert.equal(describePermission('Bash', { command: 'x'.repeat(70) }), `I want to run the command: ${'x'.repeat(60)}...`)
  assert.equal(describePermission('Write', { file_path: '/w/a.ts' }), 'I want to create or overwrite the file: /w/a.ts')
  assert.equal(describePermission('Edit', { file_path: '/w/a.ts' }), 'I want to edit the file: /w/a.ts')
  assert.equal(describePermission('WebFetch', { url: 'https://x.dev/a' }), 'I want to fetch content from: https://x.dev/a')
  assert.equal(describePermission('Task', {}), 'I need permission to use Task.')
  assert.equal(describePermission('Bash', null), 'I need permission to use Bash.')
})

t('phone prompt names the action in plain words and the three keys (#363)', () => {
  assert.equal(phoneApprovalPrompt('Bash', { command: 'npm test' }), 'Osborn wants to run the command npm test. Press 1 to allow, 2 to deny, or 3 to always allow.')
  assert.equal(speakablePermission('Edit', { file_path: '/home/sprite/workspace/src/index.ts' }), 'edit the file index.ts')
  assert.equal(speakablePermission('WebFetch', { url: 'https://docs.example.com/a?b=1' }), 'fetch a page from docs.example.com')
  assert.equal(speakablePermission('WebFetch', { url: 'not a url' }), 'fetch a web page')
  assert.equal(speakablePermission('Task', { subagent_type: 'researcher' }), 'start the researcher agent')
  assert.equal(speakablePermission('mcp__github__create_issue', {}), 'use create issue from github')
  assert.equal(speakablePermission('Bash', { command: 'a b c d e f g h i j' }), 'run the command a b c d e f g h and so on')
  assert.equal(speakablePermission('SomeTool', {}), 'use the SomeTool tool')
})

t('always allow: one file for the file tools, the whole tool otherwise', () => {
  const a = newSessionAllows()
  assert.equal(recordAlwaysAllow(a, 'Edit', { file_path: '/w/a.ts' }), '/w/a.ts')
  assert.equal(isAlwaysAllowed(a, 'Edit', { file_path: '/w/a.ts' }), true)
  assert.equal(isAlwaysAllowed(a, 'Write', { file_path: '/w/a.ts' }), true, 'same file, any file tool')
  assert.equal(isAlwaysAllowed(a, 'Edit', { file_path: '/w/b.ts' }), false, 'another file still asks')
  assert.equal(isAlwaysAllowed(a, 'Bash', { command: 'ls' }), false)
  assert.equal(recordAlwaysAllow(a, 'Bash', { command: 'npm test' }), 'Bash')
  assert.equal(isAlwaysAllowed(a, 'Bash', { command: 'rm -rf x' }), true, 'the same tool does not ask again')
  assert.equal(isAlwaysAllowed(a, 'WebFetch', { url: 'https://x' }), false)
  assert.equal(recordAlwaysAllow(a, 'Write', {}), null, 'no file, nothing recorded')
  assert.equal(isAlwaysAllowed(newSessionAllows(), 'Bash', {}), false, 'a new session starts empty')
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
