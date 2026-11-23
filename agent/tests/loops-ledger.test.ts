// Follow-through (#378) ledger: fold rules, who said it (origin), and safe appends.
// Run: npx tsx agent/tests/loops-ledger.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'loops-ledger-test-'))
process.env.CLAUDE_CONFIG_DIR = root
const L = await import('../src/loops-ledger.js')
type R = import('../src/loops-ledger.js').LoopRecord

let pass = 0
const t = (name: string, fn: () => unknown) => {
  try { fn(); pass++; console.log('ok   ', name) }
  catch (e: any) { console.log('FAIL ', name, '\n     ', String(e?.message ?? e).split('\n')[0]); process.exitCode = 1 }
}
let n = 0
const rec = (r: Partial<R>): R => ({ v: 1, at: `2026-11-01T00:00:${String(n++ % 60).padStart(2, '0')}.000Z`, fg: true, ...r } as R)
const open = (rs: R[]) => L.openLoops(rs).map((i) => i.id).sort()

t('fold: last record per id wins', () => {
  const id = L.loopIds.todo('write tests')
  const rs = [rec({ kind: 'todo', id, text: 'write tests', status: 'pending' }), rec({ kind: 'todo_status', id, status: 'in_progress' }), rec({ kind: 'todo_status', id, status: 'pending' })]
  assert.deepEqual(open(rs), [id])
})

t('todo status change closes an item', () => {
  const id = L.loopIds.todo('ship it')
  assert.deepEqual(open([rec({ kind: 'todo', id, text: 'ship it', status: 'pending' }), rec({ kind: 'todo_status', id, status: 'completed' })]), [])
})

t('TodoWrite diff by content: new items and status changes only', () => {
  const a = L.diffTodos(undefined, [{ content: 'A', status: 'pending', activeForm: 'a' } as any, { content: 'B', status: 'pending' }])
  assert.deepEqual(a.changes, [{ content: 'A', to: 'pending' }, { content: 'B', to: 'pending' }])
  const b = L.diffTodos(a.next, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }])
  assert.deepEqual(b.changes, [{ content: 'A', from: 'pending', to: 'completed' }])
})

t('TaskCreate/TaskUpdate keyed by taskId; deleted and completed close', () => {
  const id = L.loopIds.task('7')
  const created = rec({ kind: 'task', id, text: 'Refactor', status: 'pending' })
  assert.deepEqual(open([created]), [id])
  assert.deepEqual(open([created, rec({ kind: 'task_status', id, status: 'in_progress' })]), [id])
  assert.deepEqual(open([created, rec({ kind: 'task_status', id, status: 'deleted' })]), [])
  assert.deepEqual(open([created, rec({ kind: 'task_status', id, status: 'completed' })]), [])
})

t('dispatch_started without dispatch_stopped is open', () => {
  const id = L.loopIds.dispatch('ag1')
  assert.deepEqual(open([rec({ kind: 'dispatch_started', id, text: 'Unfinished writer run' })]), [id])
  assert.deepEqual(open([rec({ kind: 'dispatch_started', id, text: 'x' }), rec({ kind: 'dispatch_stopped', id })]), [])
})

t('dispatch_severed stays open', () => {
  const id = L.loopIds.dispatch('ag2')
  assert.deepEqual(open([rec({ kind: 'dispatch_started', id, text: 'x' }), rec({ kind: 'dispatch_severed', id, text: 'cut' })]), [id])
})

t('permission settled by abort stays open; by the user closes', () => {
  const id = L.loopIds.permission('r1')
  const p = rec({ kind: 'permission_pending', id, text: 'Approval never given: Bash' })
  assert.deepEqual(open([p, rec({ kind: 'permission_settled', id, by: 'abort' })]), [id])
  assert.deepEqual(open([p, rec({ kind: 'permission_settled', id, by: 'user' })]), [])
})

t('question answered closes', () => {
  const id = L.loopIds.question('tu1')
  assert.deepEqual(open([rec({ kind: 'question', id, text: 'Unanswered question: which?' }), rec({ kind: 'question_answered', id })]), [])
})

t('slot_refused is open', () => {
  const id = L.loopIds.slot('s')
  assert.deepEqual(open([rec({ kind: 'slot_refused', id, text: 'refused' })]), [id])
})

t('prompt lines never become issues', () => {
  assert.deepEqual(L.openLoops([rec({ kind: 'prompt', text: 'remind me to call Bob' }), rec({ kind: 'session', cwd: '/w' })]), [])
})

t('a filed item is no longer open', () => {
  const id = L.loopIds.ask('remind me to call Bob')
  assert.deepEqual(open([rec({ kind: 'ask', id, text: 'remind me to call Bob', source: 'explicit', origin: 'user_mic' }), rec({ kind: 'filed', id, url: 'https://github.com/o/r/issues/1' })]), [])
})

t('appendLoopRecord never throws on an unwritable dir', () => {
  const file = join(root, 'not-a-dir')
  writeFileSync(file, 'x')
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(file, 'sub')
  try { assert.equal(L.appendLoopRecord('s', '/w', { kind: 'ask', id: 'a', text: 'x' }), false) }
  finally { process.env.CLAUDE_CONFIG_DIR = prev }
})

t('records stay under 4KB', () => {
  const big = 'word '.repeat(5000)
  const line = L.serializeLoopRecord({ v: 1, at: new Date().toISOString(), kind: 'prompt', text: big })
  assert.ok(Buffer.byteLength(line) <= L.MAX_LINE_BYTES, `line ${Buffer.byteLength(line)} bytes`)
  assert.equal(JSON.parse(line).truncated, true)
  assert.ok(L.appendLoopRecord('s4', '/w', { kind: 'prompt', text: big }))
  const raw = readFileSync(L.getLoopsPath('s4', '/w'), 'utf-8')
  assert.ok(Buffer.byteLength(raw) <= L.MAX_LINE_BYTES + 1)
})

t('loopKey is stable under case and punctuation, differs by kind', () => {
  assert.equal(L.loopKey('ask', 'Remind me to call Bob!'), L.loopKey('ask', '  remind ME to call, bob '))
  assert.notEqual(L.loopKey('ask', 'x y'), L.loopKey('todo', 'x y'))
  assert.match(L.loopKey('ask', 'x'), /^[0-9a-f]{12}$/)
})

// ── Origin (who said it) ──
t('origin: meeting, system and context tags are not the user', () => {
  assert.equal(L.classifyPromptOrigin('[MEETING — bot1]:\nAlice: remind me to send the deck'), 'meeting')
  assert.equal(L.classifyPromptOrigin('[SYSTEM note — mode changed]'), 'system')
  assert.equal(L.classifyPromptOrigin('[CONTEXT: resumed] remind me to x'), 'system')
  assert.equal(L.classifyPromptOrigin('[INTERRUPTED] you said...'), 'system')
  assert.equal(L.classifyPromptOrigin('remind me to call Bob'), 'user_mic')
  assert.equal(L.classifyPromptOrigin('remind me to call Bob', { phone: true }), 'phone')
  assert.equal(L.classifyPromptOrigin('[MEETING — b]: hi', { phone: true }), 'meeting')
})

t('origin: only a user_mic record can be explicit; meeting/phone/tool/system fold to inferred', () => {
  for (const origin of ['meeting', 'phone', 'tool', 'system'] as const) {
    const id = L.loopIds.ask(`x ${origin}`)
    const [item] = L.openLoops([rec({ kind: 'ask', id, text: 'remind me to x', source: 'explicit', origin })])
    assert.equal(item.source, 'inferred', origin)
  }
  const [mine] = L.openLoops([rec({ kind: 'ask', id: 'ask:m', text: 'remind me to x', source: 'explicit', origin: 'user_mic' })])
  assert.equal(mine.source, 'explicit')
})

t('extractAsks: the user\'s own asks, verbatim and short', () => {
  const asks = L.extractAsks('Okay. Remind me to rotate the key tomorrow. Also the weather is nice! We still need to fix login.')
  assert.deepEqual(asks, ['Remind me to rotate the key tomorrow.', 'We still need to fix login.'])
  assert.deepEqual(L.extractAsks('just chatting here'), [])
  assert.ok(L.extractAsks('remind me to ' + 'a '.repeat(300))[0].length <= L.MAX_ITEM_CHARS)
})

t('background (non-foreground) records are never fileable', () => {
  const rs = [rec({ kind: 'ask', id: 'ask:b', text: 'remind me to x', source: 'explicit', origin: 'user_mic', fg: false }), rec({ kind: 'todo', id: 'todo:f', text: 'y', status: 'pending', fg: true })]
  assert.deepEqual(L.openLoops(rs).length, 2)
  assert.deepEqual(L.fileableLoops(rs).map((i) => i.id), ['todo:f'])
})


t('queued: model-written is inferred, not explicit; typed text may be explicit', () => {
  const r = L.queuedLoopRecord('fix the login bug in osborn', 'osborn')
  assert.equal(r.source, 'inferred'); assert.equal(r.origin, 'tool')
  const it = L.foldLoops([rec({ ...r } as any)]).get(r.id!)!
  assert.equal(it.kind, 'queued'); assert.equal(it.source, 'inferred')
  assert.deepEqual(open([rec({ ...r } as any)]), [r.id])
  const typed = L.queuedLoopRecord('fix it', 'osborn', { typed: true })
  assert.equal(L.foldLoops([rec({ ...typed } as any)]).get(typed.id!)!.source, 'explicit')
})

t('queued: long instruction keeps a startable body, short ellipsized title, project in the id', () => {
  const long = 'do the thing '.repeat(100)
  const r = L.queuedLoopRecord(long, 'osborn')
  assert.ok(r.text!.length <= L.MAX_ITEM_CHARS && r.text!.endsWith('…') && r.text!.startsWith('Queued for osborn'))
  assert.ok(r.instruction!.length > 500 && r.instruction!.length <= 800)
  assert.notEqual(L.queuedLoopRecord('same', 'osborn').id, L.queuedLoopRecord('same', 'audos').id)
})

t('queued: appendQueuedLoop writes into the target project ledger (not the hub), with a session line, survives restart, filed once', () => {
  const hub = join(root, 'hub'), target = join(root, 'target')
  assert.ok(L.appendQueuedLoop('tsess', target, 'ship the report', 'target'))
  assert.ok(L.appendQueuedLoop('tsess', target, 'ship the report', 'target'))
  assert.deepEqual(L.readLoopRecords('tsess', hub), [])
  const rs = L.readLoopRecords('tsess', target)
  assert.equal(rs.filter((r) => r.kind === 'session').length, 1)
  assert.equal(rs.find((r) => r.kind === 'session')!.cwd, target)
  const items = L.fileableLoops(rs)
  assert.equal(items.length, 1); assert.equal(items[0].kind, 'queued'); assert.equal(items[0].source, 'inferred')
  L.appendLoopRecord('tsess', target, { kind: 'filed', id: items[0].id, url: 'https://x/1' })
  assert.deepEqual(L.fileableLoops(L.readLoopRecords('tsess', target)), [])
})

// The real spoken path: resolveDispatchTarget refuses at the cap, the hub's dispatch handler keeps the instruction in the
// TARGET project's ledger, and the flush files it to that project's repo (never the hub's), as an inferred item.
{
  const { SlotRegistry } = await import('../src/slot-manager.js')
  const { resolveDispatchTarget } = await import('../src/dispatch.js')
  const { flushSession } = await import('../src/loops-flush.js')
  const full = new SlotRegistry({ max: 1 }); full.add({ id: 'x', llm: {}, isFocused: false, workingDir: '/w' })
  const pick = resolveDispatchTarget('audos', [{ sessionId: 'aud-1', cwd: '/work/audos', timestamp: new Date(2026, 10, 1) }],
    { seat: (id) => full.admit(id), slotState: () => 'none', dirExists: () => true, now: Date.UTC(2026, 11, 1) })
  t('spoken path: the cap refusal carries target, and queuing lands in the target ledger', () => {
    assert.equal(pick.ok, false); assert.equal(pick.reason, 'cap'); assert.equal(pick.sessionId, 'aud-1'); assert.equal(pick.cwd, '/work/audos')
    assert.ok(L.appendQueuedLoop(pick.sessionId!, pick.cwd!, 'add dark mode', pick.project!))
    assert.equal(L.readLoopRecords(pick.sessionId!, pick.cwd!).filter((r) => r.kind === 'queued').length, 1)
    assert.deepEqual(L.readLoopRecords('hub-sess', '/work/hub'), [])
  })
  const posts: any[] = []
  const fetchFn = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body); posts.push(body)
    return { status: 200, json: async () => ({ results: body.items.map((i: any) => ({ key: i.key, action: 'created', url: 'https://github.com/me/audos/issues/1' })) }) }
  }) as any
  const flushed = await flushSession('aud-1', '/work/audos', { fetchFn, syncToken: 'x', frontendUrl: 'http://127.0.0.1:9', repoFor: (c) => (c === '/work/audos' ? 'me/audos' : 'me/hub') })
  t('spoken path: flush files it to the target project repo as inferred, once', () => {
    assert.equal(flushed.status, 'done'); assert.equal(flushed.filed, 1)
    assert.equal(posts.length, 1); assert.equal(posts[0].repo, 'me/audos')
    assert.equal(posts[0].items[0].kind, 'queued'); assert.equal(posts[0].items[0].source, 'inferred'); assert.equal(posts[0].items[0].origin, 'tool')
  })
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed`)
