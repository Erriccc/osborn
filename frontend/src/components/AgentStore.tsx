'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { MagnifyingGlass, Brain, PenNib, Robot, TestTube, ListChecks, ShieldCheck, Eye } from '@phosphor-icons/react'
import { agentName, type UserAgentDraft, type UserAgentRow } from '@/lib/user-agents'
import type { SkillInfo, SkillStoreApi } from '@/lib/skill-store'

// The agent & skill store. Built-in agents and shipped skills are maintained by
// Voice Native: view and fork only. "Yours" holds what the user owns: their own
// agents and forks (edit, enable/disable, delete) and installed skills.
// Mounted in Settings → Agents & Skills and in the chat's Agents/Skills popovers.
// Every rule shown here (roles, models, limits) comes from the machine
// (agent/src/agent-store.ts, via /agents and agents_status).

/** An agent as the machine lists it (agent-store.ts describeAgents). */
export interface NamedAgent {
  name: string
  description: string
  model?: string
  tools?: string[]
  core: boolean
  prompt?: string
  /** A user agent's origin as the machine words it: the built-in it forked, or 'owner/repo @sha7'. */
  origin?: string
  /** Older machines mark the user's own agents this way instead of sending core. */
  custom?: boolean
  role: string
  summary: string
  icon: string
  behaviours: string[]
}

/** agent-store.ts describeRoles. */
export interface RolesData {
  roles: { role: string; summary: string; icon: string; behaviours: string[] }[]
  chains: string[][]
  models: string[]
  limits: { name: number; description: number; prompt: number }
}
export const rolesData = (d: any): RolesData | null =>
  Array.isArray(d?.roles) && d.limits ? { roles: d.roles, chains: d.chains || [], models: d.models || [], limits: d.limits } : null

const ICONS: Record<string, typeof Robot> = { search: MagnifyingGlass, brain: Brain, pen: PenNib, test: TestTube, list: ListChecks, shield: ShieldCheck, eye: Eye, robot: Robot }

export const card = 'rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)]/60 p-2.5'
export const field = 'w-full rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none'
export const link = 'text-[11px] text-[var(--accent)] hover:opacity-80 disabled:opacity-40'
export const heading = 'mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]'
/** Rounded toggle chip (store tabs, catalog filters). */
export const pill = (on: boolean) => `rounded-full border px-2.5 py-0.5 text-[11px] ${on ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`

/** First free name: base, base-2, base-3 … (kept within max characters). */
export const uniqueName = (base: string, taken: Set<string>, max = Infinity) => {
  let n = base.slice(0, max), i = 2
  while (taken.has(n)) { const s = `-${i++}`; n = `${base.slice(0, max - s.length)}${s}` }
  return n
}

function LockBadge() {
  return (
    <span title="Maintained by Voice Native — fork it to make your own" className="inline-flex items-center gap-0.5 rounded border border-[var(--border-subtle)] px-1 py-px text-[9px] uppercase text-[var(--text-secondary)]">
      <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
      Built in
    </span>
  )
}

function RoleLine({ role, behaviours }: { role: string; behaviours?: string[] }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-snug text-[var(--text-muted)]">
      <span className="rounded border border-[var(--accent)]/40 px-1 py-px font-semibold uppercase tracking-wide text-[var(--accent)]">{role}</span>
      {behaviours?.map((b, i) => <span key={i}>{i > 0 && '· '}{b}</span>)}
    </div>
  )
}

/** "Works together": the automatic chains, e.g. writer → tester → steward → reviewer. */
function ChainStrip({ chains }: { chains: string[][] }) {
  if (!chains.length) return null
  return (
    <div className="space-y-1">
      {chains.map((c) => (
        <div key={c.join('>')} className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--text-secondary)]">
          {c.map((r, i) => (
            <span key={r + i} className="flex items-center gap-1">
              {i > 0 && <span className="text-[var(--text-muted)]">→</span>}
              <span className="rounded bg-[var(--surface)] px-1.5 py-px capitalize">{r}</span>
            </span>
          ))}
        </div>
      ))}
      <p className="text-[10px] text-[var(--text-muted)]">Chains follow roles: any agent with the writer role is tested, stewarded and reviewed the same way.</p>
    </div>
  )
}

function ArmedDelete({ onConfirm, label = 'Delete' }: { onConfirm: () => void; label?: string }) {
  const [armed, setArmed] = useState(false)
  return (
    <button
      onClick={() => { if (armed) { onConfirm(); setArmed(false) } else { setArmed(true); setTimeout(() => setArmed(false), 4000) } }}
      className={`text-[11px] ${armed ? 'font-semibold text-red-400' : 'text-[var(--text-secondary)] hover:text-red-400'}`}
    >{armed ? 'Confirm?' : label}</button>
  )
}

/** One agent card: icon tile, name, badges, model, tool count, text, role line, tool chips, live progress. */
function AgentCard({ icon, title, badges, actions, model, tools, text, textTitle, role, behaviours, progress, children, dim }: {
  icon: string; title: ReactNode; badges?: ReactNode; actions?: ReactNode; model?: string; tools?: string[]
  text: string; textTitle?: string; role?: string; behaviours?: string[]; progress?: string | null; children?: ReactNode; dim?: boolean
}) {
  const Glyph = ICONS[icon] ?? Robot
  return (
    <div className={`${card} flex gap-3 ${dim ? 'opacity-60' : ''}`}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-gradient-to-b from-[var(--surface-2)] to-[var(--surface)]">
        <Glyph size={19} weight="duotone" color="var(--accent)" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold tracking-tight text-[var(--text-primary)]">{title}{badges}</span>
          <span className="flex shrink-0 items-center gap-2">
            {model && <span className="rounded-full border border-[var(--accent-dim)]/25 bg-[var(--accent-dim)]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--accent)]">{model}</span>}
            {tools && tools.length > 0 && <span title={tools.join(', ')} className="font-mono text-[10px] text-[var(--text-muted)]">{tools.length}⚒</span>}
            {actions}
          </span>
        </div>
        <p title={textTitle} className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--text-secondary)]">{text}</p>
        {progress && <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-amber-300/80">{progress}</p>}
        {role && <RoleLine role={role} behaviours={behaviours} />}
        {tools && tools.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tools.map((t) => <span key={t} className="rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-1.5 py-0.5 text-[9px] text-[var(--text-secondary)]">{t}</span>)}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

type Editing = { draft: UserAgentDraft; isNew: boolean }

export function AgentStore({ agents, yours, onSave, onDelete, onSetEnabled, status, progress, getPrompt, roles, browseHref }: {
  /** Agents reported by the machine; the core ones fill "Built in". */
  agents: NamedAgent[]
  /** The user's rows; null when signed out or not loaded. */
  yours: UserAgentRow[] | null
  onSave?: (a: UserAgentDraft) => Promise<string | null> | void
  onDelete?: (name: string) => void
  onSetEnabled?: (name: string, enabled: boolean) => void
  /** Optional live status (e.g. "working") shown beside an agent's name. */
  status?: (name: string) => ReactNode
  /** Optional live progress line (what a running agent is doing). */
  progress?: (name: string) => string | null
  /** Fetches a built-in agent's prompt when the listing has none (the chat's data channel never carries prompts). */
  getPrompt?: (name: string) => Promise<string | null>
  /** Roles, chains, models and limits from the machine. */
  roles?: RolesData | null
  /** Where "Browse catalogs" goes (omitted = no link). */
  browseHref?: string
}) {
  // The built-ins. An older machine sends no core flag (it marks the user's own agents
  // custom instead), so anything not marked as the user's is listed here, read-only.
  const core = agents.filter((a) => a.core !== false && !a.custom)
  const coreNames = new Set(core.map((a) => a.name))
  const mine = (yours || []).filter((r) => !coreNames.has(r.name))
  const taken = new Set([...core.map((a) => a.name), ...mine.map((r) => r.name)])
  const [editing, setEditing] = useState<Editing | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  const promptOf = (a: NamedAgent) => a.prompt ?? prompts[a.name]
  /** The prompt, fetched on demand when the listing has none. */
  const withPrompt = async (a: NamedAgent): Promise<string | null> => {
    const known = promptOf(a)
    if (known != null) return known
    const p = await getPrompt?.(a.name).catch(() => null)
    if (p != null) setPrompts((cur) => ({ ...cur, [a.name]: p }))
    return p ?? null
  }

  const limits = roles?.limits
  const roleInfo = (role: string) => roles?.roles.find((r) => r.role === role)
  const canEdit = !!(onSave && yours && roles)
  /** Where a user agent came from, as the machine labels it (enabled agents only). */
  const originOf = (r: { name: string; forked_from?: string | null }) => agents.find((a) => a.name === r.name && !a.core)?.origin ?? r.forked_from

  const fork = async (a: NamedAgent) => {
    const prompt = await withPrompt(a)
    if (prompt == null) { setSaveError(`Could not load the ${a.name} prompt from your machine.`); return }
    setSaveError(null)
    setEditing({
      isNew: true,
      draft: { name: uniqueName(`my-${a.name}`, taken, limits?.name), description: a.description.slice(0, limits?.description), prompt, model: a.model || 'inherit', tools: a.tools || [], forked_from: a.name, role: a.role },
    })
  }

  const d = editing?.draft
  const name = d ? agentName(d.name) : ''
  const nameError = !d || !limits ? '' : !name ? 'Name required'
    : !/[a-z0-9]/.test(name) ? 'Use letters or numbers'
    : name.length > limits.name ? `At most ${limits.name} characters`
    : coreNames.has(name) ? `${name} is built in — pick a new name`
    : editing!.isNew && taken.has(name) ? `${name} already exists` : ''
  const canSave = !!d && !!limits && !nameError && !!d.description.trim() && d.description.length <= limits.description && !!d.prompt.trim() && d.prompt.length <= limits.prompt
  const set = (patch: Partial<UserAgentDraft>) => editing && setEditing({
    ...editing,
    draft: { ...editing.draft, ...patch },
  })

  return (
    <div className="space-y-4">
      {(roles?.chains.length || browseHref) ? (
        <div>
          <div className="flex items-center justify-between">
            <h5 className={heading}>Works together</h5>
            {browseHref && <a className={link} href={browseHref} target="_blank" rel="noreferrer">Browse catalogs ↗</a>}
          </div>
          {roles?.chains && <ChainStrip chains={roles.chains} />}
        </div>
      ) : null}
      <div>
        <h5 className={heading}>Built in — maintained by Voice Native</h5>
        <div className="space-y-1.5">
          {core.length === 0 && <p className="text-[11px] text-[var(--text-muted)]">Connect your machine to see the built-in agents.</p>}
          {core.map((a) => (
            <AgentCard key={a.name} icon={a.icon} title={<span className="capitalize">{a.name}</span>} badges={<><LockBadge />{status?.(a.name)}</>}
              model={a.model} tools={a.tools} text={a.summary || a.description} textTitle={a.description} role={a.role} behaviours={a.behaviours} progress={progress?.(a.name)}
              actions={<>
                {(a.prompt != null || (getPrompt && roles)) && (
                  <button className={link} onClick={async () => { if (viewing === a.name) setViewing(null); else if (await withPrompt(a) != null) setViewing(a.name) }}>
                    {viewing === a.name ? 'Hide prompt' : 'View prompt'}
                  </button>
                )}
                {canEdit && (a.prompt != null || getPrompt) && <button className={link} onClick={() => fork(a)}>Fork</button>}
              </>}>
              {viewing === a.name && (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-secondary)]">{promptOf(a)}</pre>
              )}
            </AgentCard>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <h5 className={heading}>Yours</h5>
          {canEdit && (
            <button className={link} onClick={() => setEditing(editing ? null : { isNew: true, draft: { name: '', description: '', prompt: '', model: 'inherit', tools: [], role: 'reader' } })}>
              {editing ? 'Cancel' : '+ New agent'}
            </button>
          )}
        </div>
        {saveError && !d && <p className="mb-1 text-[11px] text-red-400">{saveError}</p>}
        {d && limits && roles && (
          <div className={`${card} mb-2 space-y-1.5`}>
            {d.forked_from && (coreNames.has(d.forked_from)
              ? <p className="text-[10px] text-[var(--text-secondary)]">Forking <b className="capitalize">{d.forked_from}</b>. The built-in stays as it is; your fork is a separate agent that starts with its role.</p>
              : <p className="text-[10px] text-[var(--text-secondary)]">Installed from <b>{originOf(d)}</b>.</p>)}
            <input value={d.name} disabled={!editing!.isNew} onChange={(e) => set({ name: e.target.value })} placeholder="agent-name (kebab-case)" className={field} />
            {nameError && d.name && <p className="text-[10px] text-red-400">{nameError}</p>}
            {!nameError && name && name !== d.name && <p className="text-[10px] text-[var(--text-muted)]">Saved as {name}</p>}
            <input value={d.description} onChange={(e) => set({ description: e.target.value })} maxLength={limits.description} placeholder="When should the orchestrator use this agent?" className={field} />
            <textarea value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={6} maxLength={limits.prompt} placeholder="System prompt — the agent's role, workflow, and rules" className={`${field} resize-y font-mono`} />
            <div className="flex flex-wrap gap-1.5">
              <select value={d.model} onChange={(e) => set({ model: e.target.value })} className={`${field} w-auto`}>
                {(roles.models.includes(d.model) ? roles.models : [...roles.models, d.model]).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input value={d.tools.join(', ')} onChange={(e) => set({ tools: e.target.value.split(',').map((t) => t.trim()) })} placeholder="Tools (comma-sep; empty = inherit all)" className={`${field} min-w-[12rem] flex-1`} />
            </div>
            <div>
              <select value={d.role} onChange={(e) => set({ role: e.target.value })} className={field} aria-label="Role">
                {roles.roles.map((r) => <option key={r.role} value={r.role}>Role: {r.role}</option>)}
              </select>
              <p className="mt-0.5 text-[10px] leading-snug text-[var(--text-muted)]">
                {roleInfo(d.role)?.summary} The role decides where the agent can write and which checks run after it.
              </p>
            </div>
            <button
              disabled={!canSave}
              onClick={async () => {
                if (!canSave) return
                const err = await onSave?.({ ...d, name })
                setSaveError(err || null)
                if (!err) setEditing(null)
              }}
              className="w-full rounded bg-[var(--accent)]/20 py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/30 disabled:cursor-not-allowed disabled:opacity-50"
            >Save agent (applies next session)</button>
            {saveError && <p className="text-[11px] text-red-400">Not saved: {saveError}</p>}
          </div>
        )}
        <div className="space-y-1.5">
          {yours === null && <p className="text-[11px] text-[var(--text-muted)]">Sign in to create and fork agents.</p>}
          {yours && !roles && <p className="text-[11px] text-[var(--text-muted)]">{agents.length ? 'Update osborn on your machine to create or edit agents.' : 'Connect your machine to create or edit agents.'}</p>}
          {yours && mine.length === 0 && !d && <p className="text-[11px] text-[var(--text-muted)]">No agents of your own yet. Fork a built-in or create one.</p>}
          {mine.map((r) => {
            const role = roleInfo(r.role)
            const fromCore = !!r.forked_from && coreNames.has(r.forked_from)
            return (
              <AgentCard key={r.name} dim={!r.enabled} icon={role?.icon ?? 'robot'} title={r.name} badges={r.enabled && status?.(r.name)}
                model={r.model} tools={r.tools} text={r.description} role={r.role} behaviours={role?.behaviours} progress={r.enabled ? progress?.(r.name) : null}
                actions={<>
                  {onSetEnabled && <button className={link} onClick={() => onSetEnabled(r.name, !r.enabled)}>{r.enabled ? 'Disable' : 'Enable'}</button>}
                  {canEdit && <button className={link} onClick={() => { setSaveError(null); setEditing({ isNew: false, draft: { name: r.name, description: r.description, prompt: r.prompt, model: r.model, tools: r.tools || [], forked_from: r.forked_from, role: r.role } }) }}>Edit</button>}
                  {onDelete && <ArmedDelete onConfirm={() => onDelete(r.name)} />}
                </>}>
                {r.forked_from && (
                  <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
                    {fromCore
                      ? <>Forked from <span className="capitalize">{r.forked_from}</span>.</>
                      : <>From {originOf(r)}</>}
                  </p>
                )}
              </AgentCard>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The skill's SKILL.md: mobile bottom sheet / desktop dialog. Esc, the backdrop and × close it. */
export function SkillViewer({ skill, onClose }: { skill: { name: string; content: string } | null; onClose: () => void }) {
  useEffect(() => {
    if (!skill) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [skill, onClose])
  if (!skill) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm sm:p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Skill: ${skill.name}`}>
      <div className="bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[85vh] sm:max-h-[80vh] flex flex-col shadow-2xl pb-[env(safe-area-inset-bottom)] sm:pb-0" onClick={(e) => e.stopPropagation()}>
        <div className="sm:hidden w-10 h-1 rounded-full bg-gray-700 mx-auto mt-2 mb-0.5" aria-hidden="true" />
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-white truncate">📚 {skill.name}</h3>
          <button
            onClick={onClose}
            aria-label="Close skill viewer"
            title="Close"
            className="shrink-0 -mr-1.5 flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <pre className="flex-1 overflow-auto p-4 text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap font-mono" data-selectable>{skill.content}</pre>
      </div>
    </div>
  )
}

export function SkillStore({ store }: { store: SkillStoreApi }) {
  const { skills } = store
  const [forking, setForking] = useState<{ from: string; to: string } | null>(null)
  const taken = new Set(skills.map((s) => s.folder))
  const builtIn = skills.filter((s) => s.core)
  const mine = skills.filter((s) => !s.core)
  const forkName = forking ? agentName(forking.to) : ''
  const forkError = forking && (!forkName ? 'Name required' : taken.has(forkName) ? `${forkName} already exists` : '')

  const row = (s: SkillInfo, actions: ReactNode) => (
    <div key={s.folder} className={card}>
      <div className="flex items-start justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium leading-snug text-[var(--text-primary)]">
          {s.name}{s.core && <LockBadge />}
          {s.forkedFrom && <span className="text-[10px] font-normal text-[var(--text-secondary)]">forked from {s.forkedFrom}</span>}
          {s.installedFrom && <span title={`${s.installedFrom.repo}@${s.installedFrom.sha}`} className="text-[10px] font-normal text-[var(--text-secondary)]">from {s.installedFrom.repo} @{s.installedFrom.sha.slice(0, 7)}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <button className={link} onClick={() => store.view(s.folder)}>View</button>
          {actions}
        </span>
      </div>
      {s.description && <p className="truncate text-[11px] text-[var(--text-secondary)]">{s.description}</p>}
      {forking?.from === s.folder && (
        <div className="mt-2 flex items-center gap-1.5">
          <input value={forking.to} onChange={(e) => setForking({ ...forking, to: e.target.value })} className={`${field} flex-1`} placeholder="new-skill-name" />
          <button disabled={!!forkError} className={link} onClick={() => { store.fork(forking.from, forkName); setForking(null) }}>Save copy</button>
          <button className={link} onClick={() => setForking(null)}>Cancel</button>
        </div>
      )}
      {forking?.from === s.folder && forkError && <p className="mt-1 text-[10px] text-red-400">{forkError}</p>}
    </div>
  )

  return (
    <div className="space-y-4">
      {store.error && <p className="text-[11px] text-red-400">Skill not changed: {store.error}</p>}
      {builtIn.length > 0 && (
        <div>
          <h5 className={heading}>Built in — maintained by Voice Native</h5>
          <div className="space-y-1.5">
            {builtIn.map((s) => row(s, <button className={link} onClick={() => setForking({ from: s.folder, to: uniqueName(`my-${s.folder}`, taken) })}>Fork</button>))}
          </div>
        </div>
      )}
      <div>
        <h5 className={heading}>Yours</h5>
        <div className="space-y-1.5">
          {mine.length === 0 && <p className="text-[11px] text-[var(--text-muted)]">No skills of your own yet.</p>}
          {mine.map((s) => row(s, <ArmedDelete label="Remove" onConfirm={() => store.remove(s.folder)} />))}
        </div>
      </div>
    </div>
  )
}
