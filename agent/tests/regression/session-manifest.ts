/**
 * Persisted session-list manifest (cold-boot dashboard fix, 0.9.260).
 *
 * listAllClaudeSessions() must persist a disk manifest keyed by file mtime+size
 * so a cold boot (in-memory cache wiped) serves UNCHANGED sessions without
 * re-reading them, re-reads only changed/new ones, and prunes deleted ones —
 * while returning byte-identical results to a fresh read.
 *
 *   M1  first build writes session-manifest.json with an entry per session
 *       (correct mtimeMs/size/lastMessage/messageCount)
 *   M2  a second build (in-memory cache invalidated = "cold boot") returns the
 *       SAME results, served from the manifest
 *   M3  appending to a file (new mtime+size) invalidates that entry → re-read →
 *       manifest + result reflect the new last message
 *   M4  deleting a session file PRUNES its manifest entry (no unbounded growth,
 *       no resurrected rows)
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { check, finish, sandboxHome } from './_shared.js'

sandboxHome()
const { listAllClaudeSessions, invalidateSessionListCache, getClaudeProjectsDir } = await import('../../src/config.js')

const projectsDir = getClaudeProjectsDir()
const SLUG = '-tmp-osborn-manifest-test'
const projDir = join(projectsDir, SLUG)
mkdirSync(projDir, { recursive: true })

const manifestPath = join(homedir(), '.claude', 'session-manifest.json')
try { rmSync(manifestPath, { force: true }) } catch {}

// Manifest-test-unique IDs (prefix aaaa…, all valid HEX so UUID_JSONL_RE
// accepts them) so they can't collide with other suites' leftover sessions
// (e.g. dashboard-preview's 0000000n) in the SHARED sandbox HOME under run-all.sh.
const uuid = (n: number) => `aaaa000${n}-0000-4000-8000-00000000000${n}`.slice(0, 36)
const userLine = (t: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } })
const asstLine = (t: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
const pad = (n: number) => JSON.stringify({ type: 'system', subtype: 'pad', junk: 'x'.repeat(n) })

const sA = uuid(1), sB = uuid(2)
const writeSession = (id: string, last: string, extra = '') =>
  writeFileSync(join(projDir, `${id}.jsonl`), [
    JSON.stringify({ type: 'summary', cwd: '/tmp/osborn-manifest-test' }),
    pad(600), userLine('q1'), asstLine('a1'), userLine(last), asstLine('done'), extra,
  ].filter(Boolean).join('\n') + '\n')

writeSession(sA, 'A-LAST-MSG')
writeSession(sB, 'B-LAST-MSG')

// Scope to OUR project slug — the shared sandbox HOME holds other suites' sessions.
const byId = (list: any[]) => new Map(list.filter(s => s.projectSlug === SLUG).map(s => [s.sessionId, s]))

// ── M1: first build writes a manifest with correct entries ──────────────────
const first = await listAllClaudeSessions()
const f = byId(first)
check('M1a', !!f.get(sA) && f.get(sA).lastMessage === 'A-LAST-MSG', `session A built (last=${JSON.stringify(f.get(sA)?.lastMessage)})`)
check('M1b', existsSync(manifestPath), 'session-manifest.json written to disk')
const m1 = JSON.parse(readFileSync(manifestPath, 'utf-8'))
const aKey = join(projDir, `${sA}.jsonl`)
check('M1c', !!m1.entries?.[aKey] && m1.entries[aKey].lastMessage === 'A-LAST-MSG' && typeof m1.entries[aKey].mtimeMs === 'number' && typeof m1.entries[aKey].size === 'number',
  'manifest entry carries lastMessage + mtimeMs + size')

// ── M2: cold boot (in-memory cache wiped) → same results from the manifest ──
invalidateSessionListCache()
const second = await listAllClaudeSessions()
const s = byId(second)
check('M2', s.get(sA)?.lastMessage === 'A-LAST-MSG' && s.get(sB)?.lastMessage === 'B-LAST-MSG' && second.length === first.length,
  'second build (cache invalidated) returns identical results')

// ── M3: a changed file is re-read; manifest + result update ─────────────────
appendFileSync(join(projDir, `${sA}.jsonl`), userLine('A-NEWER-MSG') + '\n' + asstLine('ok2') + '\n')
invalidateSessionListCache()
const third = await listAllClaudeSessions()
check('M3a', byId(third).get(sA)?.lastMessage === 'A-NEWER-MSG', `changed file re-read (last=${JSON.stringify(byId(third).get(sA)?.lastMessage)})`)
const m3 = JSON.parse(readFileSync(manifestPath, 'utf-8'))
check('M3b', m3.entries[aKey]?.lastMessage === 'A-NEWER-MSG', 'manifest entry updated for the changed file')

// ── M4: deleting a file prunes its manifest entry ───────────────────────────
rmSync(join(projDir, `${sB}.jsonl`), { force: true })
invalidateSessionListCache()
await listAllClaudeSessions()
const m4 = JSON.parse(readFileSync(manifestPath, 'utf-8'))
const bKey = join(projDir, `${sB}.jsonl`)
check('M4', !m4.entries[bKey], 'deleted session pruned from the manifest')

rmSync(projDir, { recursive: true, force: true })
finish('session-manifest')
