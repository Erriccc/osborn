// Approval policy (#363, #364): request descriptions, the phone prompt and the
// session always-allow list.
// Run: npx tsx agent/tests/approval-policy.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readApprovalMode, writeApprovalMode } from '../src/config.js'
import {
  approvalModeAnnouncement,
  autoApproval,
  isApprovalMode,
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

// ── Approval mode on the agent (#364) ──
t('autoApproval: ask approves nothing, auto-review only low risk, allow-all everything', () => {
  const root = '/home/sprite/workspace'
  const cases: [string, Record<string, unknown>][] = [
    ['Read', { file_path: '/etc/hosts' }],
    ['Edit', { file_path: `${root}/a.ts` }],
    ['Edit', { file_path: '/etc/a' }],
    ['Bash', { command: 'npm test' }],
    ['WebFetch', { url: 'https://x' }],
    ['mcp__slack__send', {}],
  ]
  const run = (mode: any) => cases.map(([tool, input]) => autoApproval(mode, tool, input, root).approve)
  assert.deepEqual(run('ask'), [false, false, false, false, false, false])
  assert.deepEqual(run('auto-review'), [true, true, false, false, false, false])
  assert.deepEqual(run('allow-all'), [true, true, true, true, true, true])
  assert.equal(autoApproval('auto-review', 'Bash', { command: 'ls' }).tier, 'high')
})
t('isApprovalMode accepts only the three modes', () => {
  for (const m of ['ask', 'auto-review', 'allow-all']) assert.equal(isApprovalMode(m), true, m)
  for (const m of ['', 'Allow all', 'allow_all', null, undefined, 1, {}]) assert.equal(isApprovalMode(m), false, String(m))
})
t('a call announces the active mode, and says when phone tools are off', () => {
  const on = { toolsOn: true, keypadOn: true }
  assert.match(approvalModeAnnouncement('allow-all', on), /^Allow all is on\. I will run actions without asking\.$/)
  assert.match(approvalModeAnnouncement('auto-review', on), /^Auto-review is on\. .*risky.*press 1 to allow/)
  assert.match(approvalModeAnnouncement('ask', on), /^Ask me is on\. I will ask you before each action: press 1/)
  // Tools off: nothing runs, whatever the mode.
  for (const m of ['ask', 'auto-review', 'allow-all'] as const) {
    assert.equal(approvalModeAnnouncement(m, { toolsOn: false, keypadOn: true }), 'Tools are off on phone calls for now, so on this call I can only talk.', m)
  }
})
t('tools on but keypad approvals off: every request is declined, so no mode is claimed', () => {
  for (const m of ['ask', 'auto-review', 'allow-all'] as const) {
    const said = approvalModeAnnouncement(m, { toolsOn: true, keypadOn: false })
    assert.match(said, /anything that needs your OK is declined/, m)
    assert.doesNotMatch(said, /without asking|Allow all is on|Auto-review is on|Ask me is on/, m)
  }
})
t('index.ts announces with both phone flags', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf-8')
  assert.match(src, /approvalModeAnnouncement\(approvalMode, \{ toolsOn: PHONE_TOOLS_ENABLED, keypadOn: PHONE_KEYPAD_APPROVALS_ENABLED \}\)/)
})
t('the mode is saved in config.yaml, keeping the other keys; unreadable config is not overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osb-approval-'))
  try {
    const file = join(dir, 'nested', 'config.yaml')
    assert.equal(readApprovalMode(file), 'ask', 'missing file -> ask')
    assert.equal(writeApprovalMode('allow-all', file), true)
    assert.equal(readApprovalMode(file), 'allow-all')
    writeFileSync(file, 'workingDirectory: /w\nmcpServers:\n  github:\n    enabled: true\napprovalMode: ask\n')
    assert.equal(writeApprovalMode('auto-review', file), true)
    const saved = readFileSync(file, 'utf-8')
    assert.match(saved, /workingDirectory: \/w/)
    assert.match(saved, /github:/)
    assert.equal(readApprovalMode(file), 'auto-review')
    writeFileSync(file, 'approvalMode: everything\n')
    assert.equal(readApprovalMode(file), 'ask', 'an unknown value reads as ask')
    writeFileSync(file, '- not\n- a map\n')
    assert.equal(writeApprovalMode('allow-all', file), false, 'refuses to overwrite a config it cannot read')
    assert.equal(readFileSync(file, 'utf-8'), '- not\n- a map\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
t('index.ts: the mode is applied after the phone deny and the always-allow list, before the phone prompt', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf-8')
  const start = src.indexOf("directLLM.events.on('permission_request'")
  const phoneDeny = src.indexOf("phonePermissionPolicy(inPhoneRoom()) === 'deny'", start)
  const always = src.indexOf('isAlwaysAllowed(sessionAllows', start)
  const auto = src.indexOf('autoApproval(approvalMode, toolName, input, workingDir)', start)
  const prompt = src.indexOf('phoneApprovalPrompt(toolName, input)', start)
  const card = src.indexOf("type: 'permission_request'", start)
  assert.ok(start > 0 && phoneDeny > start && always > phoneDeny && auto > always && prompt > auto && card > prompt, 'order')
  assert.match(src, /data\.type === 'set_approval_mode'[\s\S]{0,200}isApprovalMode\(data\.mode\)/)
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
