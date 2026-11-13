'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { agentName, type UserAgentDraft, type UserAgentRow } from '@/lib/user-agents'
import { effectiveRole, type SkillInfo } from './AgentStore'

// Browse tab of the agent & skill store: skills and named agents from trusted
// GitHub catalogs, read by the user's machine (GET /store/catalog), never by
// the browser. Skills install onto the machine at the pinned commit; agents
// become a user_agents row the user owns.

export interface CatalogEntry {
  id: string
  source: string
  kind: 'agent' | 'skill'
  name: string
  description: string
  tools: string[]
  model?: string
  files: string[]
  repo: string
  path: string
  sha: string
  license: string
  hasScripts: boolean
  trust: 'anthropic' | 'community'
  plugin?: string
  category?: string
}
interface SourceInfo { id: string; label: string; repo: string; trust: string; sha: string; fetchedAt: number; count: number; error?: string }
interface Catalog { sources: SourceInfo[]; entries: CatalogEntry[]; installed: string[]; recommended: { id: string; score: number; reason: string }[] }

export type StoreRequest = (path: string, method?: 'GET' | 'POST') => Promise<{ ok: boolean; d: any }>

const card = 'rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)]/60 p-2.5'
const field = 'rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none'
const link = 'text-[11px] text-[var(--accent)] hover:opacity-80 disabled:opacity-40'
const heading = 'mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]'
const chip = (on: boolean) => `rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`
const SCRIPT = /(^scripts\/|\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1|php)$)/i
const PAGE = 60

function TrustBadge({ trust }: { trust: string }) {
  return trust === 'anthropic'
    ? <span title="Published by Anthropic" className="inline-flex items-center gap-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px text-[9px] font-semibold uppercase text-emerald-400">✓ Anthropic</span>
    : <span title="Community catalog — review the prompt and files before installing" className="rounded border border-[var(--border-subtle)] px-1 py-px text-[9px] uppercase text-[var(--text-secondary)]">Community</span>
}

function ScriptsNote({ files }: { files: string[] }) {
  const scripts = files.filter((f) => SCRIPT.test(f))
  if (!scripts.length) return null
  return (
    <p className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-snug text-amber-300">
      Includes {scripts.length} script{scripts.length > 1 ? 's' : ''} ({scripts.slice(0, 3).join(', ')}{scripts.length > 3 ? '…' : ''}). They are copied to your machine and run only when the agent chooses to use this skill.
    </p>
  )
}

export function StoreBrowse({ request, yours, onInstallAgent, onSkillsChanged, takenAgentNames }: {
  request: StoreRequest
  /** The user's agents (null when signed out): marks installed agents and feeds recommendations. */
  yours: UserAgentRow[] | null
  onInstallAgent?: (a: UserAgentDraft) => Promise<string | null> | void
  onSkillsChanged?: (skills: SkillInfo[]) => void
  /** Every agent name in use (core + yours), so an install never overwrites one. */
  takenAgentNames: Set<string>
}) {
  const [data, setData] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState('all')
  const [kind, setKind] = useState<'all' | 'agent' | 'skill'>('all')
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [detail, setDetail] = useState<{ entry: CatalogEntry; content: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const [justInstalled, setJustInstalled] = useState<Set<string>>(new Set())

  const myNames = useMemo(() => (yours || []).map((r) => r.name).join(','), [yours])
  const load = useCallback((refresh = false) => {
    setLoading(true); setError(null)
    request(`/store/catalog?agents=${encodeURIComponent(myNames)}${refresh ? '&refresh=1' : ''}`)
      .then(({ ok, d }) => { if (ok) setData(d); else setError(d?.error || 'Could not load the catalog') })
      .catch(() => setError('Could not reach your machine'))
      .finally(() => setLoading(false))
  }, [request, myNames])
  useEffect(() => { load() }, [load])

  const isInstalled = (e: CatalogEntry) => justInstalled.has(e.id) || (e.kind === 'skill'
    ? !!data?.installed.includes(agentName(e.name))
    : (yours || []).some((r) => r.forked_from?.startsWith(`${e.source}:`) && r.forked_from.endsWith(`/${e.path}`)))
  const srcOf = (id: string) => data?.sources.find((s) => s.id === id)

  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (data?.entries || []).filter((e) =>
      (source === 'all' || e.source === source) && (kind === 'all' || e.kind === kind) &&
      words.every((w) => `${e.name} ${e.description} ${e.plugin || ''} ${e.category || ''}`.toLowerCase().includes(w)))
  }, [data, source, kind, q])
  const byId = useMemo(() => new Map((data?.entries || []).map((e) => [e.id, e])), [data])
  const recommended = (data?.recommended || []).map((r) => ({ ...r, entry: byId.get(r.id)! })).filter((r) => r.entry && !isInstalled(r.entry))

  const install = async (e: CatalogEntry) => {
    setBusy(e.id); setNote(null)
    try {
      const { ok, d } = await request(`/store/install?id=${encodeURIComponent(e.id)}`, 'POST')
      if (!ok) { setNote({ id: e.id, ok: false, text: d?.error || 'Install failed' }); return }
      if (e.kind === 'skill') {
        if (Array.isArray(d?.skills)) onSkillsChanged?.(d.skills)
        setNote({ id: e.id, ok: true, text: `Installed as ${d.name} — available from the next session.` })
      } else {
        let name = d.draft.name, i = 2
        while (takenAgentNames.has(name)) name = `${d.draft.name}-${i++}`
        const err = await onInstallAgent?.({ ...d.draft, name })
        if (err) { setNote({ id: e.id, ok: false, text: err }); return }
        setNote({ id: e.id, ok: true, text: `Added as ${name} (${d.draft.role}) — applies next session.` })
      }
      setJustInstalled((s) => new Set(s).add(e.id))
    } catch { setNote({ id: e.id, ok: false, text: 'Could not reach your machine' }) } finally { setBusy(null) }
  }

  const openDetail = (e: CatalogEntry) => {
    setDetail({ entry: e, content: null })
    request(`/store/entry?id=${encodeURIComponent(e.id)}`).then(({ ok, d }) => setDetail((cur) => (cur?.entry.id === e.id ? { entry: e, content: ok ? d.content : (d?.error || 'Not available') } : cur)))
      .catch(() => setDetail((cur) => (cur?.entry.id === e.id ? { entry: e, content: 'Could not reach your machine' } : cur)))
  }

  const InstallButton = ({ e }: { e: CatalogEntry }) => isInstalled(e)
    ? <span className="text-[11px] text-emerald-400">✓ Installed</span>
    : (e.kind === 'agent' && !onInstallAgent)
      ? <span className="text-[11px] text-[var(--text-muted)]">Sign in to add</span>
      : <button className="rounded bg-[var(--accent)]/20 px-2 py-0.5 text-[11px] text-[var(--accent)] hover:bg-[var(--accent)]/30 disabled:opacity-50" disabled={busy === e.id} onClick={() => install(e)}>{busy === e.id ? 'Installing…' : 'Install'}</button>

  const Card = ({ e, reason }: { e: CatalogEntry; reason?: string }) => {
    const s = srcOf(e.source)
    return (
      <div className={card}>
        <div className="flex items-start justify-between gap-2">
          <button onClick={() => openDetail(e)} className="flex min-w-0 flex-wrap items-center gap-1.5 text-left text-[13px] font-medium text-[var(--text-primary)] hover:text-[var(--accent)]">
            {e.name}
            <span className="rounded bg-[var(--surface)] px-1 py-px text-[9px] uppercase text-[var(--text-secondary)]">{e.kind}</span>
            <TrustBadge trust={e.trust} />
          </button>
          <span className="flex shrink-0 items-center gap-2">
            <button className={link} onClick={() => openDetail(e)}>Details</button>
            <InstallButton e={e} />
          </span>
        </div>
        {reason && <p className="mt-0.5 text-[10px] italic text-[var(--accent)]">{reason[0].toUpperCase() + reason.slice(1)}</p>}
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--text-secondary)]">{e.description}</p>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[var(--text-muted)]">
          <span>{s?.label || e.source}{e.plugin ? ` / ${e.plugin}` : ''}</span>
          <span>{e.license}</span>
          <span title={e.sha}>pinned @{e.sha.slice(0, 7)}</span>
          {e.model && <span>model {e.model}</span>}
          {e.tools.length > 0 && <span title={e.tools.join(', ')}>tools: {e.tools.slice(0, 5).join(', ')}{e.tools.length > 5 ? '…' : ''}</span>}
          {e.kind === 'skill' && <span title={e.files.join('\n')}>{e.files.length} file{e.files.length > 1 ? 's' : ''}{e.hasScripts ? ' incl. scripts' : ''}</span>}
        </div>
        {e.hasScripts && <ScriptsNote files={e.files} />}
        {note?.id === e.id && <p className={`mt-1 text-[11px] ${note.ok ? 'text-emerald-400' : 'text-red-400'}`}>{note.text}</p>}
      </div>
    )
  }

  if (detail) {
    const e = detail.entry
    return (
      <div className="space-y-2">
        <button className={link} onClick={() => setDetail(null)}>← Back to catalog</button>
        <div className={card}>
          <div className="flex items-start justify-between gap-2">
            <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-medium text-[var(--text-primary)]">{e.name}<TrustBadge trust={e.trust} /></span>
            <InstallButton e={e} />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--text-secondary)]">{e.description}</p>
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">
            {e.repo}/{e.path} · {e.license} · pinned @{e.sha.slice(0, 7)}
            {e.kind === 'agent' && <> · becomes <b>{effectiveRole({ tools: e.tools }, new Set())}</b> role (change it after installing)</>}
          </p>
          {e.kind === 'skill' && (
            <div className="mt-2">
              <h5 className={heading}>Files</h5>
              <ul className="grid grid-cols-1 gap-x-3 font-mono text-[10px] text-[var(--text-secondary)] sm:grid-cols-2">
                {e.files.map((f) => <li key={f} className={SCRIPT.test(f) ? 'text-amber-300' : ''}>{f}</li>)}
              </ul>
              <ScriptsNote files={e.files} />
            </div>
          )}
          {note?.id === e.id && <p className={`mt-1 text-[11px] ${note.ok ? 'text-emerald-400' : 'text-red-400'}`}>{note.text}</p>}
        </div>
        <h5 className={heading}>{e.kind === 'agent' ? 'Prompt' : 'SKILL.md'}</h5>
        <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded bg-[var(--surface)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-secondary)]">{detail.content ?? 'Loading…'}</pre>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button className={chip(source === 'all')} onClick={() => { setSource('all'); setShown(PAGE) }}>All sources</button>
        {(data?.sources || []).map((s) => (
          <button key={s.id} className={chip(source === s.id)} onClick={() => { setSource(s.id); setShown(PAGE) }} title={s.error ? `Last refresh failed: ${s.error}` : `${s.repo} @${s.sha.slice(0, 7)}`}>
            {s.trust === 'anthropic' ? '✓ ' : ''}{s.label} <span className="text-[var(--text-muted)]">{s.count}</span>{s.error ? ' ⚠' : ''}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <input value={q} onChange={(ev) => { setQ(ev.target.value); setShown(PAGE) }} placeholder="Search skills and agents" className={`${field} min-w-0 flex-1`} />
        {(['all', 'skill', 'agent'] as const).map((k) => (
          <button key={k} className={chip(kind === k)} onClick={() => { setKind(k); setShown(PAGE) }}>{k === 'all' ? 'All' : k === 'skill' ? 'Skills' : 'Agents'}</button>
        ))}
        <button className={link} disabled={loading} onClick={() => load(true)}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      <p className="text-[10px] leading-snug text-[var(--text-muted)]">Read live from GitHub by your machine and pinned to the commit shown. Skills and named agents only — MCP servers, hooks and other plugin parts are not installed.</p>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {loading && !data && <p className="text-[11px] text-[var(--text-muted)]">Reading the catalogs from GitHub… the first load can take half a minute.</p>}

      {data && !q && source === 'all' && kind === 'all' && recommended.length > 0 && (
        <div>
          <h5 className={heading}>Recommended for you</h5>
          <div className="space-y-1.5">{recommended.slice(0, 4).map((r) => <Card key={r.id} e={r.entry} reason={r.reason} />)}</div>
        </div>
      )}

      {data && (
        <div>
          <h5 className={heading}>{filtered.length} {kind === 'agent' ? 'agents' : kind === 'skill' ? 'skills' : 'results'}</h5>
          <div className="space-y-1.5">
            {filtered.slice(0, shown).map((e) => <Card key={e.id} e={e} />)}
          </div>
          {filtered.length > shown && <button className={`${link} mt-2`} onClick={() => setShown(shown + PAGE)}>Show more ({filtered.length - shown} left)</button>}
        </div>
      )}
    </div>
  )
}
