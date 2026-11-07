// Run: cd frontend && npx --yes tsx tests/outputs-model.test.ts
// Spec (build plan L4 step 1): grouping buckets by mtime; Just made = files whose
// sessionId equals the current session and createdAt is after join; star only on
// pinned rows; search by name and by content snippet; stable sort; "New" cleared
// after view. Plus the UI#13/19 REPLACE re-list rule, UI#20 preview states and the
// UI#21 favorite-save outcome.
import {
  AUTO_OPEN_OUTPUTS_ON_WRITE, ARTIFACT_LIST_CAP,
  sortOutputs, groupOutputs, dayBucket, isJustMade, searchOutputs, summarize,
  isNew, countNew, showStar, replaceArtifacts, favoriteSaveOutcome, previewKind,
  isImageName, projectOf, groupByProject, imageSrc,
  type OutputFile,
} from '../src/lib/outputs-model'

const results: [string, boolean, string?][] = []
function t(name: string, fn: () => void) {
  try { fn(); results.push([name, true]) } catch (e: any) { results.push([name, false, String(e.message).slice(0, 400)]) }
}
const ok = (c: any, m: string) => { if (!c) throw new Error(m) }
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
const names = (fs: OutputFile[]) => fs.map(f => f.fileName)

// Fixed clock: Sat 2026-11-07 15:00 local.
const NOW = new Date(2026, 10, 7, 15, 0, 0).getTime()
const H = 3600_000
const D = 24 * H
const SID = 'aaaaaaaa-1111-2222-3333-444444444444'
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444'
const ws = (sid: string, name: string) => `/root/.claude/projects/-workspace/osb/${sid}/${name}`
const f = (name: string, updatedAt: number, extra: Partial<OutputFile> = {}): OutputFile => ({
  filePath: ws(SID, name), fileName: name, type: 'notes', source: 'research', updatedAt: new Date(updatedAt), ...extra,
})

t('auto-open on write is OFF by default (coordinator decision: badge, not auto-open)', () => {
  eq(AUTO_OPEN_OUTPUTS_ON_WRITE, false, 'AUTO_OPEN_OUTPUTS_ON_WRITE')
})

t('dayBucket: today / yesterday / this week / older by calendar day', () => {
  eq(dayBucket(NOW - 1 * H, NOW), 'today', '1h ago')
  eq(dayBucket(new Date(2026, 10, 7, 0, 1).getTime(), NOW), 'today', 'just after midnight')
  eq(dayBucket(new Date(2026, 10, 6, 23, 59).getTime(), NOW), 'yesterday', 'just before midnight')
  eq(dayBucket(NOW - 3 * D, NOW), 'thisWeek', '3 days ago')
  eq(dayBucket(NOW - 6 * D, NOW), 'thisWeek', '6 days ago')
  eq(dayBucket(NOW - 8 * D, NOW), 'older', '8 days ago')
  eq(dayBucket(NaN, NOW), 'older', 'invalid date is older, never today')
})

t('groupOutputs: buckets by mtime, each file exactly once, pinned > just made > date', () => {
  const joinedAt = NOW - 2 * H
  const files: OutputFile[] = [
    f('fresh.md', NOW - 10 * 60_000, { sessionId: SID, createdAt: new Date(NOW - 10 * 60_000) }),
    f('earlier-today.md', NOW - 5 * H, { sessionId: SID }),
    f('yday.md', NOW - 1 * D),
    f('week.md', NOW - 4 * D),
    f('old.md', NOW - 30 * D),
    f('pinned-fresh.md', NOW - 5 * 60_000, { sessionId: SID, createdAt: new Date(NOW - 5 * 60_000) }),
  ]
  const g = groupOutputs(files, { now: NOW, sessionId: SID, joinedAt, pinnedPaths: new Set([ws(SID, 'pinned-fresh.md')]) })
  eq(names(g.justMade), ['fresh.md'], 'justMade')
  eq(names(g.pinned), ['pinned-fresh.md'], 'pinned')
  eq(names(g.today), ['earlier-today.md'], 'today')
  eq(names(g.yesterday), ['yday.md'], 'yesterday')
  eq(names(g.thisWeek), ['week.md'], 'thisWeek')
  eq(names(g.older), ['old.md'], 'older')
  const total = g.justMade.length + g.pinned.length + g.today.length + g.yesterday.length + g.thisWeek.length + g.older.length
  eq(total, files.length, 'every file exactly once')
})

t('isJustMade: current session AND created after join; falls back to updatedAt', () => {
  const joinedAt = NOW - 2 * H
  ok(isJustMade(f('a', NOW, { sessionId: SID, createdAt: new Date(NOW - H) }), { sessionId: SID, joinedAt }), 'created after join in this session')
  ok(!isJustMade(f('b', NOW, { sessionId: OTHER, createdAt: new Date(NOW - H) }), { sessionId: SID, joinedAt }), 'other session is not just made')
  ok(!isJustMade(f('c', NOW, { sessionId: SID, createdAt: new Date(NOW - 3 * H) }), { sessionId: SID, joinedAt }), 'created before join (later edit) is not just made')
  ok(!isJustMade(f('d', NOW, { createdAt: new Date(NOW - H) }), { sessionId: SID, joinedAt }), 'no sessionId is not just made')
  ok(isJustMade(f('e', NOW - H, { sessionId: SID }), { sessionId: SID, joinedAt }), 'no createdAt: a re-listed file with mtime after join counts (Bash-written file case)')
  ok(!isJustMade(f('g', NOW, { sessionId: SID }), { sessionId: null, joinedAt }), 'unknown current session: nothing is just made')
})

t('sortOutputs: newest first, stable tie-break by name then path, never mutates input', () => {
  const same = NOW - H
  const input = [f('b.md', same), f('a.md', same), f('z.md', NOW), f('a.md', same, { filePath: '/x/a.md' })]
  const before = JSON.stringify(input)
  const out = sortOutputs(input)
  eq(out.map(x => x.filePath), [ws(SID, 'z.md'), ws(SID, 'a.md'), '/x/a.md', ws(SID, 'b.md')], 'order')
  eq(JSON.stringify(input), before, 'input untouched')
  eq(sortOutputs(sortOutputs(input)).map(x => x.filePath), out.map(x => x.filePath), 'idempotent')
  const withBad = sortOutputs([f('bad.md', NaN), f('good.md', NOW)])
  eq(names(withBad), ['good.md', 'bad.md'], 'invalid dates sort last')
})

t('showStar: star only on pinned rows', () => {
  const pinned = new Set([ws(SID, 'p.md')])
  ok(showStar(f('p.md', NOW), pinned), 'pinned row shows star')
  ok(!showStar(f('q.md', NOW), pinned), 'unpinned row has no star')
})

t('searchOutputs: name/path/type match, then content matches with a snippet, no duplicates', () => {
  const files = [
    f('railway-notes.md', NOW - H, { content: 'unrelated' }),
    f('deploy.md', NOW - 2 * H, { content: '# Deploy\n\nWe push to Railway on merge.\nMore text' }),
    f('plain.md', NOW - 3 * H, { content: 'nothing here' }),
    f('img.png', NOW, { content: 'cmFpbHdheQ==', isImage: true, type: 'image' }),
    f('unloaded.md', NOW),
  ]
  const r = searchOutputs(files, 'RAILWAY')
  eq(names(r.byName), ['railway-notes.md'], 'byName')
  eq(r.byContent.map(m => m.file.fileName), ['deploy.md'], 'byContent (images and unloaded files skipped)')
  ok(r.byContent[0].snippet.includes('We push to Railway on merge.'), `snippet is the matching line, got ${JSON.stringify(r.byContent[0].snippet)}`)
  const all = searchOutputs(files, '   ')
  eq(all.byName.length, files.length, 'blank query returns every file')
  eq(all.byContent.length, 0, 'blank query has no content section')
  eq(names(searchOutputs(files, 'osb').byName).length, files.length, 'path matches (folder name)')
})

t('searchOutputs: long content line is clipped around the match', () => {
  const long = 'x'.repeat(300) + ' needle ' + 'y'.repeat(300)
  const r = searchOutputs([f('long.md', NOW, { content: long })], 'needle')
  ok(r.byContent.length === 1, 'found')
  ok(r.byContent[0].snippet.length <= 125, `snippet clipped, len ${r.byContent[0].snippet.length}`)
  ok(r.byContent[0].snippet.includes('needle'), 'snippet keeps the match')
})

t('summarize: first meaningful line, markdown stripped, clipped; null without content', () => {
  eq(summarize(f('a.md', NOW, { content: '---\ntitle: x\n---\n\n# Big Title\n\nThe **real** first line.' })), 'Big Title', 'heading text')
  eq(summarize(f('b.md', NOW, { content: '\n\n```\ncode\n```\nAfter code' })), 'After code', 'skips code fences')
  eq(summarize(f('c.html', NOW, { type: 'html', content: '<html><head><title>Report</title></head><body><p>Hi</p></body></html>' })), 'Report', 'html title')
  eq(summarize(f('d.html', NOW, { type: 'html', content: '<div><p>Hello <b>there</b></p></div>' })), 'Hello there', 'html text')
  eq(summarize(f('e.md', NOW)), null, 'no content')
  eq(summarize(f('f.png', NOW, { content: 'AAAA', isImage: true })), null, 'images have no text summary')
  const s = summarize(f('g.md', NOW, { content: 'w '.repeat(200) }))!
  ok(s.length <= 100 && s.endsWith('…'), 'clipped to 100 with ellipsis')
})

t('"New": isNew after seenAt, countNew, and cleared after view (seenAt advanced)', () => {
  const seenAt = NOW - H
  const files = [f('new.md', NOW - 10 * 60_000), f('old.md', NOW - 2 * H), f('edited.md', NOW - 30 * 60_000)]
  ok(isNew(files[0], seenAt) && !isNew(files[1], seenAt), 'isNew compares updatedAt with seenAt')
  eq(countNew(files, seenAt), 2, 'two unseen')
  eq(countNew(files, NOW), 0, 'after viewing (seenAt = now) nothing is new')
  eq(countNew([f('bad', NaN)], 0), 0, 'invalid date is never new')
})

t('replaceArtifacts: REPLACE for this session folder; keep pinned, plans, other sessions, bucket files', () => {
  const pinnedPaths = new Set([ws(SID, 'pinned-gone.md')])
  const prev: OutputFile[] = [
    f('kept.md', NOW - 5 * H, { content: 'cached', url: 'https://u/kept', createdAt: new Date(NOW - 6 * H) }),
    f('vanished.md', NOW - 5 * H),
    f('pinned-gone.md', NOW - 5 * H),
    { filePath: '/root/.claude/plans/p.md', fileName: 'p.md', type: 'plan', source: 'plan', updatedAt: new Date(NOW) },
    { filePath: ws(OTHER, 'x.md'), fileName: 'x.md', type: 'notes', source: 'research', updatedAt: new Date(NOW) },
    { filePath: 'user/sess/artifacts/b.md', fileName: 'b.md', type: 'notes', source: 'research', updatedAt: new Date(NOW), url: 'https://bucket/b' },
  ]
  const incoming: OutputFile[] = [
    { filePath: ws(SID, 'kept.md'), fileName: 'kept.md', type: 'notes', source: 'research', updatedAt: new Date(NOW - H) },
    { filePath: ws(SID, 'bash-written.md'), fileName: 'bash-written.md', type: 'notes', source: 'research', updatedAt: new Date(NOW - 2 * 60_000) },
  ]
  const out = replaceArtifacts(prev, incoming, { sessionId: SID, pinnedPaths })
  const paths = out.map(x => x.filePath)
  ok(!paths.includes(ws(SID, 'vanished.md')), 'vanished file in this session folder is dropped')
  ok(paths.includes(ws(SID, 'pinned-gone.md')), 'pinned file is never dropped')
  ok(paths.includes('/root/.claude/plans/p.md'), 'plan file kept')
  ok(paths.includes(ws(OTHER, 'x.md')), 'other session file kept')
  ok(paths.includes('user/sess/artifacts/b.md'), 'bucket file kept')
  ok(paths.includes(ws(SID, 'bash-written.md')), 'new file added')
  const kept = out.find(x => x.filePath === ws(SID, 'kept.md'))!
  eq(kept.content, undefined, 'changed mtime invalidates cached content (lazy refetch)')
  eq(kept.url, undefined, 'and its stale url')
  eq(new Date(kept.updatedAt).getTime(), NOW - H, 'updatedAt refreshed from disk')
  eq(new Date(kept.createdAt!).getTime(), NOW - 6 * H, 'createdAt preserved')
  eq(kept.sessionId, SID, 'stamped with the session id')
  eq(new Set(paths).size, paths.length, 'no duplicate paths')
})

t('replaceArtifacts: unchanged mtime keeps cached content; capped or session-less lists merge only', () => {
  const prev = [f('same.md', NOW - H, { content: 'cached' }), f('other.md', NOW - H)]
  const same = replaceArtifacts(prev, [{ ...prev[0], content: undefined }], { sessionId: SID, pinnedPaths: new Set() })
  eq(same.find(x => x.fileName === 'same.md')!.content, 'cached', 'content kept when mtime unchanged')
  const capped = Array.from({ length: ARTIFACT_LIST_CAP }, (_, i) => f(`n${i}.md`, NOW - i * 1000))
  const merged = replaceArtifacts(prev, capped, { sessionId: SID, pinnedPaths: new Set() })
  ok(merged.some(x => x.fileName === 'other.md'), 'a list at the agent cap is partial: nothing dropped')
  const noSid = replaceArtifacts(prev, [f('n.md', NOW)], { sessionId: null, pinnedPaths: new Set() })
  ok(noSid.some(x => x.fileName === 'other.md'), 'no session id: merge only')
})

t('favoriteSaveOutcome: 2xx ok; 401 guest stays local; other failures roll back', () => {
  eq(favoriteSaveOutcome(200), 'ok', '200')
  eq(favoriteSaveOutcome(204), 'ok', '204')
  eq(favoriteSaveOutcome(401), 'local-only', '401 guest')
  eq(favoriteSaveOutcome(500), 'rollback', '500')
  eq(favoriteSaveOutcome(400), 'rollback', '400')
  eq(favoriteSaveOutcome(null), 'rollback', 'network error')
})

t('previewKind + isImageName: images by extension, no fake "Empty file", honest states', () => {
  ok(isImageName('a.PNG') && isImageName('b.webp') && !isImageName('c.svg') && !isImageName('d.md'), 'isImageName')
  eq(previewKind(f('a.png', NOW, { url: 'https://u/a.png', isImage: false })), 'image', 'image by extension even when isImage=false')
  eq(previewKind(f('a.png', NOW, { content: 'AAAA' })), 'image', 'inline base64 image')
  eq(previewKind(f('a.png', NOW, { content: '', truncated: true, isImage: false })), 'unavailable', 'too-big image with no bytes')
  eq(previewKind(f('a.png', NOW)), 'loading', 'image not fetched yet')
  eq(previewKind(f('a.md', NOW)), 'loading', 'text not fetched yet')
  eq(previewKind(f('a.md', NOW, { content: '' })), 'empty', 'really empty file')
  eq(previewKind(f('a.md', NOW, { content: '', truncated: true })), 'unavailable', 'truncated with no text')
  eq(previewKind(f('a.md', NOW, { loadError: 'ENOENT' })), 'error', 'load error')
  eq(previewKind(f('a.md', NOW, { content: '# hi' })), 'markdown', 'markdown')
  eq(previewKind(f('a.html', NOW, { type: 'html', content: '<p>x</p>' })), 'html', 'html')
  eq(previewKind(f('a.svg', NOW, { content: '<svg/>' })), 'svg', 'svg markup')
  eq(previewKind(f('a.svg', NOW, { url: 'https://u/a.svg' })), 'image', 'svg by url')
  eq(previewKind(f('a.mmd', NOW, { content: 'graph TD' })), 'mermaid', 'mermaid')
  eq(previewKind(f('a.pdf', NOW, { url: 'https://u/a.pdf' })), 'pdf', 'pdf')
  eq(previewKind(f('a.zip', NOW, { url: 'https://u/a.zip' })), 'link', 'binary url')
  eq(previewKind(f('a.md', NOW, { url: 'https://u/a.md' })), 'loading', 'text url awaiting hydration')
  eq(imageSrc(f('a.jpg', NOW, { content: 'AAAA' })), 'data:image/jpeg;base64,AAAA', 'inline data url')
  eq(imageSrc(f('a.png', NOW, { url: 'https://u/a.png', content: 'AAAA' })), 'https://u/a.png', 'url wins')
})

t('projectOf / groupByProject: project slug and session from the path', () => {
  eq(projectOf(ws(SID, 'a.md')), { project: 'workspace', session: SID.slice(0, 8) }, 'workspace session file')
  eq(projectOf('/root/.claude/plans/p.md'), { project: 'Plans', session: null }, 'plans')
  eq(projectOf('user-1/' + SID + '/artifacts/b.md'), { project: 'Saved copies', session: SID.slice(0, 8) }, 'bucket copy')
  eq(projectOf('/tmp/x.md'), { project: 'Other', session: null }, 'other')
  const groups = groupByProject([
    f('a.md', NOW - H),
    { ...f('x.md', NOW), filePath: '/root/.claude/projects/-home-sprite-workspace-app/osb/' + OTHER + '/x.md' },
    f('b.md', NOW - 2 * H),
  ])
  eq(groups.map(g => g.project), ['home-sprite-workspace-app', 'workspace'], 'projects ordered by latest file')
  eq(names(groups[1].sessions[0].files), ['a.md', 'b.md'], 'files sorted within a session')
})

const failed = results.filter(r => !r[1])
for (const [name, pass, msg] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${msg ? `\n      ${msg}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
