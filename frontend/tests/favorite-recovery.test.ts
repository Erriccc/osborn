// Run: cd frontend && npx --yes tsx tests/favorite-recovery.test.ts
// Spec (bug 55033541): favorites made before durable copies existed (metadata
// only, no url) opened as a dead "No saved copy" page. Now, when such a file is
// opened, its body is fetched from the agent machine (get_research_artifact /
// get_plan_file, the owner-only room). If it comes back the favorite is
// repaired with a durable copy (the agent's uploaded url, or an upload of the
// full body). If it cannot be recovered (agent error, no reply in time, file
// outside the served folders, empty), the view offers "Remove from favorites"
// and "Ask agent to regenerate".
import {
  favoriteCopyState, favoriteRepairAction, regeneratePrompt, CONTENT_REPLY_TIMEOUT_MS,
  LOAD_ERROR_OUTSIDE, LOAD_ERROR_NO_REPLY,
  type OutputFile,
} from '../src/lib/outputs-model'

let pass = 0, fail = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('PASS', name) } catch (e: any) { fail++; console.log('FAIL', name, String(e?.message || e).slice(0, 400)) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const base: OutputFile = { filePath: '/workspace/.claude/projects/-workspace/osb/s1/zed.txt', fileName: 'zed.txt', type: 'other', updatedAt: 0 }

t('a reply timeout exists and is short', () => ok(CONTENT_REPLY_TIMEOUT_MS > 0 && CONTENT_REPLY_TIMEOUT_MS <= 20_000, String(CONTENT_REPLY_TIMEOUT_MS)))

t('not pinned: never a favorite problem', () => {
  eq(favoriteCopyState({ ...base, loadError: 'ENOENT' }, false), 'ok', 'unpinned')
})

t('pinned with a durable url: ok', () => {
  eq(favoriteCopyState({ ...base, url: 'https://s/zed.txt' }, true), 'ok', 'url')
})

t('pinned, no url, nothing loaded yet: recovering (fetch from the agent)', () => {
  eq(favoriteCopyState(base, true), 'recovering', 'recovering')
})

t('pinned, full body came back: repairable', () => {
  eq(favoriteCopyState({ ...base, content: 'hello' }, true), 'repairable', 'text')
  eq(favoriteCopyState({ ...base, fileName: 'a.png', isImage: true, content: 'iVBORw0KGgo=' }, true), 'repairable', 'image base64')
})

t('pinned, unrecoverable: dead', () => {
  eq(favoriteCopyState({ ...base, loadError: 'ENOENT: no such file' }, true), 'dead', 'agent error')
  eq(favoriteCopyState({ ...base, loadError: LOAD_ERROR_NO_REPLY }, true), 'dead', 'no reply')
  eq(favoriteCopyState({ ...base, filePath: '/workspace/zed.txt', loadError: LOAD_ERROR_OUTSIDE }, true), 'dead', 'outside served folders')
  eq(favoriteCopyState({ ...base, content: '' }, true), 'dead', 'empty body')
  eq(favoriteCopyState({ ...base, content: 'first 5k', truncated: true }, true), 'dead', 'only a truncated preview')
})

t('repair action: copy the agent-uploaded url onto the favorite', () => {
  eq(favoriteRepairAction({ ...base }, { ...base, url: 'https://s/zed.txt' }), { kind: 'set-url', url: 'https://s/zed.txt' }, 'set-url')
})

t('repair action: upload a full body', () => {
  eq(favoriteRepairAction({ ...base }, { ...base, content: 'hello' }), { kind: 'upload' }, 'upload')
})

t('repair action: none when the favorite already has a url, nothing loaded, or unrecoverable', () => {
  eq(favoriteRepairAction({ ...base, url: 'https://s/x' }, { ...base, content: 'x' }), null, 'already durable')
  eq(favoriteRepairAction(base, base), null, 'nothing yet')
  eq(favoriteRepairAction(base, { ...base, loadError: 'ENOENT' }), null, 'dead')
  eq(favoriteRepairAction(base, null), null, 'not listed')
})

t('regenerate prompt names the file and where it was', () => {
  const p = regeneratePrompt({ ...base })
  ok(p.includes('zed.txt'), 'name')
  ok(p.includes(base.filePath), 'path')
  ok(!p.startsWith('['), 'a real request, not a bracketed control notice')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
