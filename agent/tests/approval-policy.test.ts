// Approval policy (#363, #364): request descriptions, the phone prompt and the
// session always-allow list.
// Run: npx tsx agent/tests/approval-policy.test.ts
import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readApprovalMode, writeApprovalMode } from '../src/config.js'
import {
  alwaysScope,
  answerPending,
  answerPendingWithoutId,
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
  assert.equal(phoneApprovalPrompt('Bash', { command: 'npm test' }), 'Osborn wants to run the command npm test. Press 1 to allow, 2 to deny, or 3 to always allow this exact command for this call.')
  assert.match(phoneApprovalPrompt('Edit', { file_path: '/w/a.ts' }), /3 to always allow this file for this call\.$/)
  assert.match(phoneApprovalPrompt('WebFetch', { url: 'https://x.dev' }), /3 to always allow this exact request for this call\.$/)
  assert.equal(speakablePermission('Edit', { file_path: '/home/sprite/workspace/src/index.ts' }), 'edit the file index.ts')
  assert.equal(speakablePermission('WebFetch', { url: 'https://docs.example.com/a?b=1' }), 'fetch a page from docs.example.com')
  assert.equal(speakablePermission('WebFetch', { url: 'not a url' }), 'fetch a web page')
  assert.equal(speakablePermission('Task', { subagent_type: 'researcher' }), 'start the researcher agent')
  assert.equal(speakablePermission('mcp__github__create_issue', {}), 'use create issue from github')
  assert.equal(speakablePermission('Bash', { command: 'a b c d e f g h i j' }), 'run the command a b c d e f g h and so on')
  assert.equal(speakablePermission('SomeTool', {}), 'use the SomeTool tool')
})

t('always allow: this file, this exact command, a read by its exact file or search, else this exact request', () => {
  const a = newSessionAllows()
  assert.equal(recordAlwaysAllow(a, 'Edit', { file_path: '/w/a.ts' }), 'path:/w/a.ts')
  assert.equal(isAlwaysAllowed(a, 'Edit', { file_path: '/w/a.ts' }), true)
  assert.equal(isAlwaysAllowed(a, 'Write', { file_path: '/w/a.ts' }), true, 'same file, any file tool')
  assert.equal(isAlwaysAllowed(a, 'Edit', { file_path: '/w/b.ts' }), false, 'another file still asks')
  // Bash: the exact command only.
  recordAlwaysAllow(a, 'Bash', { command: 'npm test', description: 'run tests' })
  assert.equal(isAlwaysAllowed(a, 'Bash', { command: 'npm test', timeout: 5000 }), true, 'same command')
  assert.equal(isAlwaysAllowed(a, 'Bash', { command: 'rm -rf x' }), false, 'another command still asks')
  assert.equal(isAlwaysAllowed(a, 'Bash', { command: 'npm test && curl evil' }), false)
  // Read tools never as a whole: Read by exact file, Grep/Glob by exact search.
  recordAlwaysAllow(a, 'Read', { file_path: '/w/notes.md' })
  assert.equal(isAlwaysAllowed(a, 'Read', { file_path: '/w/notes.md', offset: 10 }), true, 'same file')
  assert.equal(isAlwaysAllowed(a, 'Read', { file_path: '/w/.env' }), false, 'another file still asks')
  assert.equal(isAlwaysAllowed(a, 'Write', { file_path: '/w/notes.md' }), false, 'reading a file never covers writing it')
  recordAlwaysAllow(a, 'Grep', { pattern: 'x', path: '/w/src' })
  assert.equal(isAlwaysAllowed(a, 'Grep', { path: '/w/src', pattern: 'x' }), true, 'same search')
  assert.equal(isAlwaysAllowed(a, 'Grep', { pattern: 'y', path: '/etc' }), false, 'another search still asks')
  assert.equal(isAlwaysAllowed(a, 'Grep', { pattern: 'x', path: '/etc' }), false, 'same pattern, another path')
  recordAlwaysAllow(a, 'LS', { path: '/w' })
  assert.equal(isAlwaysAllowed(a, 'LS', { path: '/' }), false)
  // Everything else: the exact input (key order does not matter).
  recordAlwaysAllow(a, 'WebFetch', { url: 'https://x', prompt: 'p' })
  assert.equal(isAlwaysAllowed(a, 'WebFetch', { prompt: 'p', url: 'https://x' }), true)
  assert.equal(isAlwaysAllowed(a, 'WebFetch', { url: 'https://evil', prompt: 'p' }), false)
  recordAlwaysAllow(a, 'mcp__slack__send', { channel: 'a', text: 'hi' })
  assert.equal(isAlwaysAllowed(a, 'mcp__slack__send', { channel: 'b', text: 'hi' }), false)
  assert.equal(recordAlwaysAllow(a, 'Write', {}), null, 'no file, nothing recorded')
  assert.equal(recordAlwaysAllow(a, 'Bash', {}), null, 'no command, nothing recorded')
  assert.equal(isAlwaysAllowed(newSessionAllows(), 'Read', {}), false, 'a new session starts empty')
})
t('answerPending settles only the request the answer names; a late answer never settles another', () => {
  const holder = (requestId: string, toolName = 'Bash', input: any = { command: 'npm test' }) => {
    let pending: any = { toolName, input, requestId }
    const settled: boolean[] = []
    return {
      settled,
      get pending() { return pending },
      getPendingPermission: () => pending,
      respondToPermission: (allow: boolean, _m?: string, id?: string) => {
        if (!pending || (id !== undefined && id !== pending.requestId)) return false
        settled.push(allow); pending = null; return true
      },
    }
  }
  const allows = newSessionAllows()
  const a = holder('req-A')
  assert.equal(answerPending(a, 'allow', 'req-A', allows), true)
  assert.deepEqual(a.settled, [true])
  // A late click for A, while B (a newer request, or a parked brain's) is pending: B is untouched.
  const b = holder('req-B')
  assert.equal(answerPending(b, 'allow', 'req-A', allows), false)
  assert.equal(answerPending(b, 'always_allow', 'req-A', allows), false)
  assert.deepEqual(b.settled, [])
  assert.equal(b.pending?.requestId, 'req-B')
  assert.equal(isAlwaysAllowed(allows, 'Bash', { command: 'npm test' }), false, 'a late Always records nothing')
  // No id, or an empty one, settles nothing.
  assert.equal(answerPending(b, 'deny', undefined, allows), false)
  assert.equal(answerPending(b, 'deny', '', allows), false)
  assert.equal(answerPending(null, 'deny', 'req-B', allows), false)
  // The right id: Always records that request's scope.
  assert.equal(answerPending(b, 'always_allow', 'req-B', allows), true)
  assert.equal(isAlwaysAllowed(allows, 'Bash', { command: 'npm test' }), true)
  assert.equal(isAlwaysAllowed(allows, 'Bash', { command: 'npm run build' }), false)
})
t('an answer with no id (an older tab or app) settles only the live session\'s sole pending request', () => {
  const holder = (requestId: string | null) => {
    let pending: any = requestId ? { toolName: 'Bash', input: { command: 'npm test' }, requestId } : null
    const settled: boolean[] = []
    return {
      settled,
      getPendingPermission: () => pending,
      respondToPermission: (allow: boolean, _m?: string, id?: string) => {
        if (!pending || (id !== undefined && id !== pending.requestId)) return false
        settled.push(allow); pending = null; return true
      },
    }
  }
  // Live request, nothing parked: settled.
  const live = holder('L1')
  assert.equal(answerPendingWithoutId(live, holder(null), 'allow'), true)
  assert.deepEqual(live.settled, [true])
  // Live and parked both pending: not exactly one, nothing settled.
  const live2 = holder('L2'); const parked2 = holder('P2')
  assert.equal(answerPendingWithoutId(live2, parked2, 'allow'), false)
  assert.equal(answerPendingWithoutId(live2, parked2, 'deny'), false)
  assert.deepEqual(live2.settled, []); assert.deepEqual(parked2.settled, [])
  // Only a parked brain pending: never settled by a no-id answer.
  const parked3 = holder('P3')
  assert.equal(answerPendingWithoutId(holder(null), parked3, 'deny'), false)
  assert.equal(answerPendingWithoutId(null, parked3, 'allow'), false)
  assert.deepEqual(parked3.settled, [])
  // Deny works the same way.
  const live4 = holder('L4')
  assert.equal(answerPendingWithoutId(live4, null, 'deny'), true)
  assert.deepEqual(live4.settled, [false])
})
t('a no-id Always is allow-once: nothing is recorded', () => {
  const allows = newSessionAllows()
  let pending: any = { toolName: 'Bash', input: { command: 'npm test' }, requestId: 'L' }
  const live = {
    getPendingPermission: () => pending,
    respondToPermission: (_a: boolean, _m?: string, id?: string) => { if (!pending || id !== pending.requestId) return false; pending = null; return true },
  }
  assert.equal(answerPendingWithoutId(live, null, 'always_allow'), true)
  assert.equal(allows.size, 0)
  assert.equal(answerPendingWithoutId.length, 3, 'no always-allow list is even passed in')
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf-8')
  const at = src.indexOf("data.type === 'permission_response'")
  const body = src.slice(at, at + 1200)
  assert.match(body, /data\.requestId === undefined\s+\? answerPendingWithoutId\(currentLLM as any, warmLLM as any, answer\)\s+: settlePendingPermission\(answer, data\.requestId\)/)
})
t('ClaudeLLM.respondToPermission refuses an answer for another request id', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/claude-llm.ts'), 'utf-8')
  assert.match(src, /respondToPermission\(allow: boolean, message\?: string, requestId\?: string\): boolean \{\s+[^\n]*\n\s+if \(requestId !== undefined && this\.#pendingPermission\?\.requestId !== requestId\) return false/)
  assert.match(src, /const requestId = crypto\.randomUUID\(\)\s+this\.#pendingPermission = \{ toolName, input, requestId, resolve \}/)
  assert.match(src, /emit\('permission_request', \{ toolName, input, requestId \}\)/)
})
t('alwaysScope labels what the Always button and keypad 3 cover', () => {
  assert.equal(alwaysScope('Write', { file_path: '/w/a' }).label, 'this file')
  assert.equal(alwaysScope('Bash', { command: 'ls' }).label, 'this exact command')
  assert.equal(alwaysScope('Read', { file_path: '/w/a' }).label, 'reading this file')
  assert.equal(alwaysScope('LS', { path: '/w' }).label, 'listing this folder')
  assert.equal(alwaysScope('Grep', { pattern: 'x' }).label, 'this exact search')
  assert.equal(alwaysScope('Glob', { pattern: '*.ts' }).label, 'this exact search')
  assert.equal(alwaysScope('Task', { prompt: 'x' }).label, 'this exact request')
  for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebSearch']) {
    assert.doesNotMatch(alwaysScope(tool, { pattern: 'x', file_path: '/w/a', path: '/w' }).label, /every/, `${tool} is never allowed as a whole`)
  }
  assert.match(phoneApprovalPrompt('Read', { file_path: '/w/a.md' }), /3 to always allow reading this file for this call\.$/)
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
  assert.deepEqual(run('auto-review'), [false, true, false, false, false, false], 'a read outside the cwd is not low risk')
  assert.deepEqual(run('allow-all'), [true, true, true, true, true, true])
  assert.equal(autoApproval('auto-review', 'Bash', { command: 'ls' }, root).tier, 'high')
  assert.equal(autoApproval('auto-review', 'Edit', { file_path: `${root}/.claude/settings.json` }, root).approve, false, 'agent settings are never auto-approved')
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
    // Comments, key order and the file's permissions survive.
    writeFileSync(file, '# my osborn config\nworkingDirectory: /w # where I work\napprovalMode: ask\n# trailing note\n')
    chmodSync(file, 0o600)
    assert.equal(writeApprovalMode('allow-all', file), true)
    const kept = readFileSync(file, 'utf-8')
    assert.match(kept, /^# my osborn config\nworkingDirectory: \/w # where I work\napprovalMode: allow-all\n/)
    assert.match(kept, /# trailing note\n$/)
    assert.equal(statSync(file).mode & 0o777, 0o600, 'keeps 0600')
    chmodSync(file, 0o640)
    assert.equal(writeApprovalMode('ask', file), true)
    assert.equal(statSync(file).mode & 0o777, 0o640, 'keeps 0640')
    writeFileSync(file, '')
    assert.equal(writeApprovalMode('ask', file), true, 'an empty file becomes a map')
    assert.equal(readApprovalMode(file), 'ask')
    writeFileSync(file, 'a: [unclosed\n')
    assert.equal(writeApprovalMode('allow-all', file), false, 'refuses YAML with errors')
    assert.equal(readFileSync(file, 'utf-8'), 'a: [unclosed\n')
    // A symlinked config is written through to its target; the link stays a link.
    const target = join(dir, 'dotfiles', 'osborn.yaml')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '# kept in my dotfiles\napprovalMode: ask\n')
    const link = join(dir, 'link-config.yaml')
    symlinkSync(target, link)
    assert.equal(writeApprovalMode('auto-review', link), true)
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'still a symlink')
    assert.match(readFileSync(target, 'utf-8'), /^# kept in my dotfiles\napprovalMode: auto-review\n/)
    assert.equal(readApprovalMode(link), 'auto-review')
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
  const phoneDeny = src.indexOf("if (phoneRoute === 'deny')", start)
  const always = src.indexOf('isAlwaysAllowed(sessionAllows', start)
  const auto = src.indexOf('autoApproval(approvalMode, toolName, input, workingDir)', start)
  const prompt = src.indexOf('phoneApprovalPrompt(toolName, input)', start)
  const card = src.indexOf("type: 'permission_request'", start)
  assert.ok(start > 0 && phoneDeny > start && always > phoneDeny && auto > always && prompt > auto && card > prompt, 'order')
  assert.match(src, /data\.type === 'set_approval_mode'[\s\S]{0,200}isApprovalMode\(data\.mode\)/)
})

console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
