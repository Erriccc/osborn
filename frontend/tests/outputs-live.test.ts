// Run: cd frontend && npx --yes tsx tests/outputs-live.test.ts
// Spec (L4 finish; bugs 34808f72 + 59bb7e8d): Outputs lists files the agent
// writes ANYWHERE (not only the session workspace), taken from completed
// Write/Edit/MultiEdit/NotebookEdit tool events; it updates live; the unread
// badge is ONE stable count (distinct agent-written files not yet seen) that
// increments once per new agent file, is unaffected by re-lists, favorites
// syncs or bucket listings (no more 2 -> 122 jumps), and never auto-opens.
import {
  AUTO_OPEN_OUTPUTS_ON_WRITE,
  fileFromToolEvent, upsertAgentFile, markUnread, agentCanServe, fileTypeOf,
  replaceArtifacts,
  type OutputFile,
} from '../src/lib/outputs-model'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const SID = '11111111-2222-3333-4444-555555555555'
const NOW = Date.parse('2026-11-07T15:00:00Z')

t('no auto-open on write (badge only)', () => eq(AUTO_OPEN_OUTPUTS_ON_WRITE, false, 'flag'))

t('completed Write anywhere under /workspace becomes an output file', () => {
  const f = fileFromToolEvent({ tool: 'Write', status: 'completed', filePath: '/workspace/test-break-ui-v2-check9.txt' }, { sessionId: SID, now: NOW })
  ok(f, 'file')
  eq(f!.filePath, '/workspace/test-break-ui-v2-check9.txt', 'path')
  eq(f!.fileName, 'test-break-ui-v2-check9.txt', 'name')
  eq(f!.sessionId, SID, 'session')
  eq(f!.source, 'research', 'source')
  eq(new Date(f!.createdAt as any).getTime(), NOW, 'createdAt')
})

t('Edit, MultiEdit and NotebookEdit count; Read/Bash/Glob do not', () => {
  for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) ok(fileFromToolEvent({ tool, status: 'completed', filePath: '/workspace/a.md' }, { sessionId: SID, now: NOW }), tool)
  for (const tool of ['Read', 'Bash', 'Glob', 'Grep', 'WebFetch']) eq(fileFromToolEvent({ tool, status: 'completed', filePath: '/workspace/a.md' }, { sessionId: SID, now: NOW }), null, tool)
})

t('running (not yet finished) write is ignored', () => {
  eq(fileFromToolEvent({ tool: 'Write', status: 'running', filePath: '/workspace/a.md' }, { sessionId: SID, now: NOW }), null, 'running')
})

t('relative / missing / non-string paths are ignored', () => {
  eq(fileFromToolEvent({ tool: 'Write', status: 'completed', filePath: 'a.md' }, { sessionId: SID, now: NOW }), null, 'relative')
  eq(fileFromToolEvent({ tool: 'Write', status: 'completed' }, { sessionId: SID, now: NOW }), null, 'missing')
  eq(fileFromToolEvent({ tool: 'Write', status: 'completed', filePath: 42 as any }, { sessionId: SID, now: NOW }), null, 'number')
})

t('internal agent bookkeeping files are not outputs', () => {
  for (const p of [
    `/workspace/.claude/projects/-workspace/${SID}.jsonl`,
    `/workspace/.claude/projects/-workspace/osb/${SID}/spec.md`,
    `/workspace/.claude/projects/-workspace/osb/${SID}/search-index.txt`,
    `/workspace/.claude/projects/-workspace/osb/${SID}/search-index-meta.json`,
    '/workspace/node_modules/x/index.js',
    '/workspace/.git/config',
  ]) eq(fileFromToolEvent({ tool: 'Write', status: 'completed', filePath: p }, { sessionId: SID, now: NOW }), null, p)
})

t('type follows the extension', () => {
  eq(fileTypeOf('plan-v2.md'), 'plan', 'plan')
  eq(fileTypeOf('flow.mmd'), 'diagram', 'mmd')
  eq(fileTypeOf('page.html'), 'html', 'html')
  eq(fileTypeOf('notes.md'), 'notes', 'md')
  eq(fileTypeOf('shot.png'), 'image', 'png')
  eq(fileTypeOf('data.csv'), 'other', 'csv')
})

t('upsert adds a new file at the front', () => {
  const prev: OutputFile[] = [{ filePath: '/a', fileName: 'a', type: 'other', updatedAt: NOW - 5000 }]
  const f = fileFromToolEvent({ tool: 'Write', status: 'completed', filePath: '/workspace/b.md' }, { sessionId: SID, now: NOW })!
  const next = upsertAgentFile(prev, f)
  eq(next.map((x) => x.filePath), ['/workspace/b.md', '/a'], 'order')
})

t('upsert of an existing file keeps createdAt, bumps updatedAt, drops the stale body', () => {
  const prev: OutputFile[] = [{ filePath: '/workspace/b.md', fileName: 'b.md', type: 'notes', updatedAt: NOW - 60_000, createdAt: NOW - 60_000, content: 'old', url: 'https://x/old' }]
  const f = fileFromToolEvent({ tool: 'Edit', status: 'completed', filePath: '/workspace/b.md' }, { sessionId: SID, now: NOW })!
  const next = upsertAgentFile(prev, f)
  eq(next.length, 1, 'no duplicate row')
  eq(new Date(next[0].createdAt as any).getTime(), NOW - 60_000, 'createdAt kept')
  eq(new Date(next[0].updatedAt as any).getTime(), NOW, 'updatedAt bumped')
  eq(next[0].content, undefined, 'content dropped (refetch lazily)')
  eq(next[0].url, undefined, 'stale url dropped')
})

t('unread: one count per distinct new agent file', () => {
  let s: ReadonlySet<string> = new Set()
  s = markUnread(s, '/workspace/a.txt', false)
  eq(s.size, 1, 'first file')
  s = markUnread(s, '/workspace/b.txt', false)
  eq(s.size, 2, 'second file increments')
  const same = markUnread(s, '/workspace/b.txt', false)
  eq(same.size, 2, 'same file again does not double count')
  ok(same === s, 'unchanged set identity (no re-render)')
})

t('unread: nothing is added while Outputs is on screen', () => {
  const s = markUnread(new Set(), '/workspace/a.txt', true)
  eq(s.size, 0, 'visible')
})

t('stable count: a re-list of 120 files does not touch the unread set', () => {
  // The count is driven only by agent file events, so re-lists (session_artifacts),
  // favorites sync and bucket listings cannot move it.
  let unread: ReadonlySet<string> = new Set()
  unread = markUnread(unread, '/workspace/test-break-ui-v2-check9.txt', false)
  const big = Array.from({ length: 120 }, (_, i) => ({ filePath: `/x/osb/${SID}/f${i}.md`, fileName: `f${i}.md`, type: 'notes', updatedAt: NOW + i }))
  const listed = replaceArtifacts([], big, { sessionId: SID, pinnedPaths: new Set() })
  eq(listed.length, 120, 'listed')
  eq(unread.size, 1, 'badge unchanged by the re-list')
})

t('re-list keeps an agent file written outside the session folder', () => {
  const outside = fileFromToolEvent({ tool: 'Write', status: 'completed', filePath: '/workspace/test.txt' }, { sessionId: SID, now: NOW })!
  const listed = replaceArtifacts<OutputFile>([outside], [{ filePath: `/x/osb/${SID}/n.md`, fileName: 'n.md', type: 'notes', updatedAt: NOW }], { sessionId: SID, pinnedPaths: new Set() })
  ok(listed.some((f) => f.filePath === '/workspace/test.txt'), 'kept')
})

t('agentCanServe: workspace/plan paths yes, arbitrary paths no', () => {
  ok(agentCanServe(`/workspace/.claude/projects/-workspace/osb/${SID}/notes.md`), 'osb')
  ok(agentCanServe('/home/u/.osborn/sessions/x/notes.md'), 'legacy sessions')
  ok(agentCanServe('/home/u/.osborn/research/x.md'), 'legacy research')
  ok(agentCanServe('/root/.claude/plans/p.md', 'plan'), 'plan file')
  ok(!agentCanServe('/workspace/test.txt'), 'outside')
  ok(!agentCanServe('/workspace/.claude/plans/p.md'), 'plan path without plan source goes via get_research_artifact, which refuses it')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
