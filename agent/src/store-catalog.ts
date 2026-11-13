// Store catalog: skills and named agents from trusted GitHub repos, read live
// through the agent (the frontend never calls GitHub), cached on disk for an
// hour, pinned at the commit they were read at. MCP servers, hooks, bin and
// monitors are out of scope: entries that need MCP are skipped.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep, posix } from 'node:path'
import { promisify } from 'node:util'
import MiniSearch from 'minisearch'
import { STOPWORDS } from './stopwords.js'
import { storeName, draftRole, isAgentModel, parseFrontMatter, catalogOrigin, unpinnedOrigin, AGENT_LIMITS, type Role } from './agent-store.js'

const run = promisify(execFile)

type EntryKind = 'agent' | 'skill'
type Trust = 'anthropic' | 'community'

interface CatalogSource {
  id: string
  label: string
  repo: string            // owner/name
  trust: Trust
  /** Path patterns: group 1 is the plugin (if any), the match is the entry. */
  skill: RegExp           // matches <dir>/SKILL.md
  agent?: RegExp          // matches <file>.md
}

export const SOURCES: CatalogSource[] = [
  { id: 'anthropic-skills', label: 'Anthropic skills', repo: 'anthropics/skills', trust: 'anthropic', skill: /^skills\/[^/]+\/SKILL\.md$/ },
  {
    id: 'anthropic-plugins', label: 'Anthropic plugins', repo: 'anthropics/claude-plugins-official', trust: 'anthropic',
    skill: /^plugins\/([^/]+)\/skills\/[^/]+\/SKILL\.md$/, agent: /^plugins\/([^/]+)\/agents\/[^/]+\.md$/,
  },
  {
    id: 'wshobson-agents', label: 'wshobson/agents', repo: 'wshobson/agents', trust: 'community',
    skill: /^plugins\/([^/]+)\/skills\/[^/]+\/SKILL\.md$/, agent: /^plugins\/([^/]+)\/agents\/[^/]+\.md$/,
  },
]

export interface CatalogEntry {
  id: string              // <source>:<path>
  source: string
  kind: EntryKind
  name: string
  description: string
  tools: string[]
  model?: string
  files: string[]         // relative to the skill folder (skills) / [basename] (agents)
  repo: string
  path: string            // skill folder or agent file
  sha: string
  license: string
  /** Files that can run (scripts/ or a script extension), shown before install. */
  scripts: string[]
  trust: Trust
  plugin?: string
  category?: string
}

export interface Snapshot { sha: string; paths: string[] }
type Reader = (path: string) => Promise<string | null>

// ── Parsing ──────────────────────────────────────────────────────────────────

const str = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? '')).trim()
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean)
const SCRIPT_EXT = /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|php)$/i
const isHidden = (rel: string) => rel.split('/').some((s) => s.startsWith('.'))

function detectLicense(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  const head = text.slice(0, 600)
  if (/MIT License/i.test(head)) return 'MIT'
  if (/Apache License/i.test(head)) return 'Apache-2.0'
  if (/BSD/i.test(head)) return 'BSD'
  return 'See LICENSE'
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
  }))
  return out
}

/** Turns a repo snapshot into catalog entries (pure apart from `read`). Returns the bodies too. */
export async function normaliseSource(src: CatalogSource, snap: Snapshot, read: Reader): Promise<{ entries: CatalogEntry[]; bodies: Record<string, string>; failed: number }> {
  let failed = 0
  const paths = snap.paths
  const repoLicense = detectLicense(await read(paths.find((p) => /^LICEN[CS]E(\.md|\.txt)?$/i.test(p)) || 'LICENSE').catch(() => null))
  const market: Record<string, { category?: string }> = {}
  try {
    const mp = JSON.parse((await read('.claude-plugin/marketplace.json')) || '{}')
    for (const p of Array.isArray(mp.plugins) ? mp.plugins : []) if (p?.name) market[String(p.name)] = { category: p.category ? String(p.category) : undefined }
  } catch { /* marketplace metadata is optional */ }

  const hits = paths.flatMap((p): { kind: EntryKind; file: string; plugin?: string }[] => {
    const s = src.skill.exec(p)
    if (s) return [{ kind: "skill", file: p, plugin: s[1] }]
    const a = src.agent?.exec(p)
    return a ? [{ kind: "agent", file: p, plugin: a[1] }] : []
  })
  const bodies: Record<string, string> = {}
  const entries = (await mapLimit(hits, 8, async (h): Promise<CatalogEntry | null> => {
    const md = await read(h.file).catch(() => { failed++; return null })
    if (!md) return null
    const { meta, body } = parseFrontMatter(md)
    const dir = h.kind === 'skill' ? posix.dirname(h.file) : h.file
    const files = h.kind === 'skill'
      ? paths.filter((p) => p.startsWith(dir + '/')).map((p) => p.slice(dir.length + 1)).filter((r) => !isHidden(r))
      : [posix.basename(h.file)]
    const tools = list(meta.tools ?? meta['allowed-tools'])
    // Out of scope: anything that needs an MCP server.
    if (tools.some((t) => /^mcp__/.test(t)) || paths.some((p) => p.startsWith(dir + '/') && posix.basename(p) === '.mcp.json')) return null
    const name = storeName(str(meta.name) || (h.kind === 'skill' ? posix.basename(dir) : posix.basename(h.file, '.md')))
    if (!name) return null
    const ownLicense = str(meta.license)
    const id = `${src.id}:${dir}`
    bodies[id] = h.kind === 'agent' ? body.trim() : md
    return {
      id, source: src.id, kind: h.kind, name,
      description: str(meta.description).slice(0, 600),
      tools, ...(str(meta.model) ? { model: str(meta.model) } : {}),
      files, repo: src.repo, path: dir, sha: snap.sha,
      license: ownLicense ? (/LICENSE/i.test(ownLicense) ? 'See LICENSE.txt' : ownLicense.slice(0, 40)) : (files.some((f) => /^LICEN[CS]E/i.test(f)) ? 'See LICENSE.txt' : repoLicense || 'Unknown'),
      scripts: files.filter((f) => f.startsWith('scripts/') || SCRIPT_EXT.test(f)),
      trust: src.trust,
      ...(h.plugin ? { plugin: h.plugin, ...(market[h.plugin]?.category ? { category: market[h.plugin].category } : {}) } : {}),
    }
  })).filter((e): e is CatalogEntry => !!e)
  return { entries, bodies, failed }
}

// ── Fetching ─────────────────────────────────────────────────────────────────

const GH_API = 'https://api.github.com'
const GH_RAW = 'https://raw.githubusercontent.com'
const ghHeaders = (): Record<string, string> => ({
  'User-Agent': 'osborn-store',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
})

async function snapshotViaApi(repo: string): Promise<Snapshot> {
  const c = await fetch(`${GH_API}/repos/${repo}/commits/HEAD`, { headers: { ...ghHeaders(), Accept: 'application/vnd.github.sha' }, signal: AbortSignal.timeout(15000) })
  if (!c.ok) throw new Error(`commit lookup ${c.status}`)
  const sha = (await c.text()).trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('bad commit sha')
  const t = await fetch(`${GH_API}/repos/${repo}/git/trees/${sha}?recursive=1`, { headers: { ...ghHeaders(), Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) })
  if (!t.ok) throw new Error(`tree ${t.status}`)
  const tree = await t.json() as { tree?: { path: string; type: string }[] }
  return { sha, paths: (tree.tree || []).filter((n) => n.type === 'blob').map((n) => n.path) }
}

/** Fallback when the API is rate-limited or blocked: a blobless depth-1 clone, file names only. */
async function snapshotViaGit(repo: string): Promise<Snapshot> {
  const d = mkdtempSync(join(tmpdir(), 'osborn-store-'))
  try {
    await run('git', ['clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', `https://github.com/${repo}`, d], { timeout: 60000 })
    const sha = (await run('git', ['-C', d, 'rev-parse', 'HEAD'])).stdout.trim()
    const ls = (await run('git', ['-C', d, 'ls-tree', '-r', '--name-only', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 })).stdout
    return { sha, paths: ls.split('\n').filter(Boolean) }
  } finally { rmSync(d, { recursive: true, force: true }) }
}

async function snapshot(repo: string): Promise<Snapshot> {
  try { return await snapshotViaApi(repo) } catch (e) {
    console.log(`[store] ${repo}: API listing failed (${e instanceof Error ? e.message : e}); trying git`)
    return snapshotViaGit(repo)
  }
}

const MAX_FILE_BYTES = 2 * 1024 * 1024
async function rawBytes(repo: string, sha: string, path: string): Promise<Buffer | null> {
  const r = await fetch(`${GH_RAW}/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(20000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`raw ${r.status}`)  // rate limit / outage: a failure, not a missing file
  const buf = Buffer.from(await r.arrayBuffer())
  return buf.length > MAX_FILE_BYTES ? null : buf
}
const rawReader = (repo: string, sha: string): Reader => async (p) => (await rawBytes(repo, sha, p))?.toString('utf-8') ?? null

// ── Cache ────────────────────────────────────────────────────────────────────

const TTL_MS = 60 * 60 * 1000
const cacheDir = () => join(homedir(), '.osborn', 'store-cache')

interface SourceCache { source: string; repo: string; sha: string; fetchedAt: number; entries: CatalogEntry[]; bodies: Record<string, string>; error?: string }

const inflight = new Map<string, Promise<SourceCache>>()

async function loadSource(src: CatalogSource, opts: { refresh?: boolean; dir?: string } = {}): Promise<SourceCache> {
  const file = join(opts.dir || cacheDir(), `${src.id}.v2.json`)  // v2: entries carry scripts[]
  let cached: SourceCache | null = null
  try { cached = JSON.parse(readFileSync(file, 'utf-8')) } catch { /* none yet */ }
  if (cached && !opts.refresh && Date.now() - cached.fetchedAt < TTL_MS) return cached
  if (inflight.has(src.id)) return inflight.get(src.id)!
  const p = (async () => {
    try {
      const snap = await snapshot(src.repo)
      const { entries, bodies, failed } = await normaliseSource(src, snap, rawReader(src.repo, snap.sha))
      const fresh: SourceCache = { source: src.id, repo: src.repo, sha: snap.sha, fetchedAt: Date.now(), entries, bodies }
      // Some files could not be read: never cache a partial catalog over a good one.
      if (failed) {
        const error = `${failed} file(s) could not be read from GitHub`
        console.warn(`[store] ${src.id}: ${error}`)
        return { ...(cached ?? fresh), error }
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file + '.tmp', JSON.stringify(fresh))
      renameSync(file + '.tmp', file)
      return fresh
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.warn(`[store] ${src.id}: ${error}`)
      // A stale catalog beats none.
      return cached ? { ...cached, error } : { source: src.id, repo: src.repo, sha: '', fetchedAt: 0, entries: [], bodies: {}, error }
    } finally { inflight.delete(src.id) }
  })()
  inflight.set(src.id, p)
  return p
}

export async function loadCatalog(ids: string[] | null, opts: { refresh?: boolean; dir?: string } = {}): Promise<SourceCache[]> {
  return Promise.all(SOURCES.filter((s) => !ids || ids.includes(s.id)).map((s) => loadSource(s, opts)))
}

export async function findEntry(id: string, opts: { dir?: string } = {}): Promise<{ entry: CatalogEntry; body: string } | null> {
  const src = SOURCES.find((s) => id.startsWith(s.id + ':'))
  if (!src) return null
  const c = await loadSource(src, opts)
  const entry = c.entries.find((e) => e.id === id)
  return entry ? { entry, body: c.bodies[id] || '' } : null
}

// ── Install ──────────────────────────────────────────────────────────────────

export const PROVENANCE_FILE = '.store-provenance.json'
const MAX_SKILL_BYTES = 10 * 1024 * 1024
const MAX_SKILL_FILES = 300

/** A file path inside a skill: relative, no '..', no hidden segments, no backslashes. */
export function safeRelPath(rel: string): boolean {
  if (!rel || rel.includes('\\') || rel.includes('\0') || posix.isAbsolute(rel)) return false
  const parts = rel.split('/')
  return parts.every((p) => p && p !== '.' && p !== '..' && !p.startsWith('.'))
}

/** Copies a catalog skill into skillsDir/<name>/ at its pinned sha, with a provenance file. */
export async function installSkill(
  entry: CatalogEntry, skillsDir: string, coreSkills: Set<string>,
  fetchFile: (path: string) => Promise<Buffer | null> = (p) => rawBytes(entry.repo, entry.sha, p),
): Promise<{ ok: true; name: string } | { error: string }> {
  if (entry.kind !== 'skill') return { error: 'not a skill' }
  const name = storeName(entry.name)
  if (!name) return { error: 'invalid skill name' }
  if (coreSkills.has(name)) return { error: `${name} is a built-in skill name — fork the built-in instead` }
  const dst = join(skillsDir, name)
  if (existsSync(dst)) return { error: `a skill named ${name} is already installed` }
  if (!entry.files.includes('SKILL.md')) return { error: 'skill has no SKILL.md' }
  if (entry.files.length > MAX_SKILL_FILES) return { error: `skill has too many files (${entry.files.length})` }
  for (const f of entry.files) {
    if (!safeRelPath(f) || !resolve(dst, f).startsWith(resolve(dst) + sep)) return { error: `refused unsafe path: ${f}` }
  }
  mkdirSync(skillsDir, { recursive: true })
  const tmp = mkdtempSync(join(skillsDir, `.installing-${name}-`))
  try {
    let total = 0
    for (const f of entry.files) {
      const buf = await fetchFile(`${entry.path}/${f}`)
      if (!buf) return { error: `could not fetch ${f}` }
      total += buf.length
      if (total > MAX_SKILL_BYTES) return { error: 'skill is larger than 10 MB' }
      const out = join(tmp, f)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, buf)
    }
    writeFileSync(join(tmp, PROVENANCE_FILE), JSON.stringify({
      source: entry.source, repo: entry.repo, sha: entry.sha, path: entry.path, license: entry.license,
      files: entry.files, scripts: entry.scripts, installedAt: new Date().toISOString(),
    }, null, 2))
    renameSync(tmp, dst)
    return { ok: true, name }
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

export function skillProvenance(skillsDir: string, folder: string): { source: string; repo: string; sha: string } | undefined {
  try {
    const p = JSON.parse(readFileSync(join(skillsDir, folder, PROVENANCE_FILE), 'utf-8'))
    return p?.source && p?.sha ? { source: String(p.source), repo: String(p.repo), sha: String(p.sha) } : undefined
  } catch { return undefined }
}

/** A user_agents draft for a catalog agent; the frontend saves it. Its role starts from its tools (draftRole). */
export function agentDraft(entry: CatalogEntry, body: string): { name: string; description: string; prompt: string; model: string; tools: string[]; role: Role; forked_from: string } {
  const tools = entry.tools.filter((t) => !/^mcp__/.test(t))
  const model = isAgentModel(entry.model) ? entry.model : 'inherit'
  return {
    name: storeName(entry.name).slice(0, AGENT_LIMITS.name),
    description: (entry.description || entry.name).slice(0, AGENT_LIMITS.description),
    prompt: body.slice(0, AGENT_LIMITS.prompt),
    model, tools, role: draftRole(tools),
    forked_from: catalogOrigin(entry),
  }
}

/** Ids of the entries already installed: a skill by its folder, an agent by a row installed from the same file. */
export function installedIds(entries: CatalogEntry[], skillFolders: Set<string>, agentOrigins: string[]): Set<string> {
  const origins = new Set(agentOrigins.map(unpinnedOrigin))
  return new Set(entries.filter((e) => (e.kind === 'skill' ? skillFolders.has(e.name) : origins.has(unpinnedOrigin(catalogOrigin(e))))).map((e) => e.id))
}

// ── Recommendations ──────────────────────────────────────────────────────────

interface Signal { text: string; reason: string }
interface Recommendation { id: string; score: number; reason: string }

// Stopwords: the shared English list plus words every catalog entry shares. The transcript
// fillers the content lens adds (work, time, look, good, thing…) stay searchable here: in a
// skill or agent description they name what it does ("time tracking", "look up").
const STOP = new Set([...STOPWORDS, 'use', 'agent', 'skill', 'skills', 'agents', 'using', 'used', 'user', 'users', 'help', 'let', 'please', 'new'])
const processTerm = (t: string) => { const w = t.toLowerCase(); return w.length < 3 || STOP.has(w) || /^\d+$/.test(w) ? null : w }

/** Ranks entries against what the user does (installed skills, agents, recent session titles); installed ids are left out. */
export function recommend(entries: CatalogEntry[], signals: Signal[], installed: Set<string>, limit = 8): Recommendation[] {
  const pool = entries.filter((e) => !installed.has(e.id))
  if (!pool.length || !signals.length) return []
  const ms = new MiniSearch<CatalogEntry>({
    fields: ['name', 'description', 'plugin', 'category'],
    storeFields: ['id'],
    processTerm,
    searchOptions: { boost: { name: 3, plugin: 2, category: 1.5 }, prefix: true, combineWith: 'OR' },
  })
  ms.addAll(pool)
  const acc = new Map<string, { score: number; best: number; reason: string }>()
  for (const s of signals) {
    const hits = ms.search(s.text.replace(/[-_/]/g, ' ')).slice(0, 20)
    const top = hits[0]?.score || 1
    for (const h of hits) {
      const v = h.score / top  // each signal counts at most 1 per entry, so a long title cannot dominate
      const a = acc.get(h.id as string) || { score: 0, best: 0, reason: '' }
      a.score += v
      if (v > a.best) { a.best = v; a.reason = s.reason }
      acc.set(h.id as string, a)
    }
  }
  const nameOf = new Map(pool.map((e) => [e.id, e.name]))
  const seen = new Set<string>()  // the same agent ships in several plugins: show it once
  return [...acc.entries()].map(([id, a]) => ({ id, score: Math.round(a.score * 100) / 100, reason: a.reason }))
    .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id))
    .filter((r) => { const n = nameOf.get(r.id)!; if (seen.has(n)) return false; seen.add(n); return true })
    .slice(0, limit)
}
