'use client'

import { useState, type ReactNode } from 'react'
import { MagnifyingGlass, Brain, PenNib, Robot, TestTube, ListChecks, ShieldCheck, Eye } from '@phosphor-icons/react'
import { agentName, type UserAgentDraft, type UserAgentRow } from '@/lib/user-agents'

// The agent & skill store. Built-in agents and shipped skills are maintained by
// Voice Native: view and fork only. "Yours" holds what the user owns: their own
// agents and forks (edit, enable/disable, delete) and installed skills.
// Mounted in Settings → Agents & Skills and in the chat's Agents/Skills popovers.

export interface NamedAgent {
  name: string
  description: string
  model?: string
  tools?: string[]
  core: boolean
  prompt?: string
  forkedFrom?: string
  role?: string
  behaviours?: string[]
}

export interface SkillInfo {
  name: string
  description: string
  folder?: string
  core?: boolean
  forkedFrom?: string
  installedFrom?: { source: string; repo: string; sha: string }
}

/** Roles and chains as the machine reports them (agent-store.ts describeRoles). */
export interface RoleInfo { role: string; summary: string; behaviours: string[] }
export interface RolesData { roles: RoleInfo[]; chains: string[][] }

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/** Display copy of agent-store.ts resolveRole: set role, else the parent's, else from tools. */
export const effectiveRole = (r: { role?: string | null; forked_from?: string | null; tools?: string[] }, coreNames: Set<string>) =>
  r.role || (r.forked_from && coreNames.has(r.forked_from) ? r.forked_from : (r.tools || []).some((t) => EDIT_TOOLS.includes(t)) ? 'writer' : 'reader')

/** Where an installed catalog agent came from: 'source:owner/repo@sha/path' → 'owner/repo @sha7'. */
export const originLabel = (from: string) => {
  const m = /^[a-z0-9-]+:([^@]+)@([0-9a-f]{7})[0-9a-f]*\//.exec(from)
  return m ? `${m[1]} @${m[2]}` : from
}

// Plain-language one-liners for the built-in agents; the raw description is
// an orchestrator instruction, not copy for people.
const AGENT_BLURBS: Record<string, string> = {
  researcher: 'Digs through your code and the web to gather facts and examples.',
  reasoner: 'Thinks through hard problems and writes a plan — it doesn’t edit files.',
  writer: 'Makes the actual code changes — edits files and runs commands.',
  tester: 'Runs the tests and checks that the work holds up.',
  planner: 'Breaks a task into clear, ordered steps.',
  reviewer: 'Reviews the changes for problems before they ship.',
  steward: 'Keeps the code lean: reuses what already exists and makes sure the change breaks nothing that depends on it.',
}

const AGENT_ICONS: Record<string, typeof Robot> = { researcher: MagnifyingGlass, reasoner: Brain, writer: PenNib, tester: TestTube, planner: ListChecks, steward: ShieldCheck, reviewer: Eye }

const MAX_PROMPT = 20000
const MODELS = ['inherit', 'sonnet', 'opus', 'haiku', 'fable']

export const card = 'rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)]/60 p-2.5'
export const field = 'w-full rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none'
export const link = 'text-[11px] text-[var(--accent)] hover:opacity-80 disabled:opacity-40'
export const heading = 'mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]'

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
export function ChainStrip({ chains }: { chains: string[][] }) {
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

const uniqueName = (base: string, taken: Set<string>) => {
  let n = base, i = 2
  while (taken.has(n)) n = `${base}-${i++}`
  return n
}

export function AgentStore({ agents, yours, onSave, onDelete, onSetEnabled, status, roles, browseHref }: {
  /** Agents reported by the machine; the core ones fill "Built in". */
  agents: NamedAgent[]
  /** The user's rows; null when signed out or not loaded. */
  yours: UserAgentRow[] | null
  onSave?: (a: UserAgentDraft) => Promise<string | null> | void
  onDelete?: (name: string) => void
  onSetEnabled?: (name: string, enabled: boolean) => void
  /** Optional live status (e.g. "working") shown beside an agent's name. */
  status?: (name: string) => ReactNode
  /** Role list + chains for the role picker and the chain strip. */
  roles?: RolesData | null
  /** Where "Browse catalogs" goes (omitted = no link). */
  browseHref?: string
}) {
  const core = agents.filter((a) => a.core)
  const coreNames = new Set(core.map((a) => a.name))
  const mine = (yours || []).filter((r) => !coreNames.has(r.name))
  const taken = new Set([...core.map((a) => a.name), ...mine.map((r) => r.name)])
  const [editing, setEditing] = useState<{ draft: UserAgentDraft; isNew: boolean } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)

  const fork = (a: NamedAgent) => setEditing({
    isNew: true,
    draft: { name: uniqueName(`my-${a.name}`, taken), description: a.description.slice(0, 500), prompt: a.prompt || '', model: a.model || 'inherit', tools: a.tools || [], forked_from: a.name },
  })

  const d = editing?.draft
  const name = d ? agentName(d.name) : ''
  const nameError = !d ? '' : !name ? 'Name required'
    : coreNames.has(name) ? `${name} is built in — pick a new name`
    : editing!.isNew && taken.has(name) ? `${name} already exists` : ''
  const canSave = !!d && !nameError && !!d.description.trim() && d.description.length <= 500 && !!d.prompt.trim() && d.prompt.length <= MAX_PROMPT
  const set = (patch: Partial<UserAgentDraft>) => editing && setEditing({ ...editing, draft: { ...editing.draft, ...patch } })
  const roleInfo = (role: string) => roles?.roles.find((r) => r.role === role)
  const rowRole = (r: UserAgentDraft) => agents.find((a) => a.name === r.name && !a.core)?.role || effectiveRole(r, coreNames)

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
            <div key={a.name} className={card}>
              <div className="flex items-start justify-between gap-2">
                <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium capitalize text-[var(--text-primary)]">
                  {(() => { const Glyph = AGENT_ICONS[a.name] ?? Robot; return <Glyph size={15} weight="duotone" color="var(--accent)" /> })()}
                  {a.name}<LockBadge />{status?.(a.name)}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {a.model && <span className="rounded-full bg-[var(--accent-dim)]/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--accent)]">{a.model}</span>}
                  {a.prompt && <button className={link} onClick={() => setViewing(viewing === a.name ? null : a.name)}>{viewing === a.name ? 'Hide prompt' : 'View prompt'}</button>}
                  {onSave && yours && a.prompt && <button className={link} onClick={() => fork(a)}>Fork</button>}
                  {!a.prompt && <a className={link} href="/settings">View or fork in Settings</a>}
                </span>
              </div>
              <p title={a.description} className="mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)]">{AGENT_BLURBS[a.name] ?? a.description}</p>
              {a.role && <RoleLine role={a.role} behaviours={a.behaviours ?? roleInfo(a.role)?.behaviours} />}
              {viewing === a.name && (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-secondary)]">{a.prompt}</pre>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <h5 className={heading}>Yours</h5>
          {onSave && yours && (
            <button className={link} onClick={() => setEditing(editing ? null : { isNew: true, draft: { name: '', description: '', prompt: '', model: 'inherit', tools: [] } })}>
              {editing ? 'Cancel' : '+ New agent'}
            </button>
          )}
        </div>
        {d && (
          <div className={`${card} mb-2 space-y-1.5`}>
            {d.forked_from && (coreNames.has(d.forked_from)
              ? <p className="text-[10px] text-[var(--text-secondary)]">Forking <b className="capitalize">{d.forked_from}</b>. The built-in keeps running in the automatic chain; your fork runs when you ask for it by name, with the same role.</p>
              : <p className="text-[10px] text-[var(--text-secondary)]">Installed from <b>{originLabel(d.forked_from)}</b>.</p>)}
            <input value={d.name} disabled={!editing!.isNew} onChange={(e) => set({ name: e.target.value })} placeholder="agent-name (kebab-case)" className={field} />
            {nameError && d.name && <p className="text-[10px] text-red-400">{nameError}</p>}
            <input value={d.description} onChange={(e) => set({ description: e.target.value })} maxLength={500} placeholder="When should the orchestrator use this agent?" className={field} />
            <textarea value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={6} maxLength={MAX_PROMPT} placeholder="System prompt — the agent's role, workflow, and rules" className={`${field} resize-y font-mono`} />
            <div className="flex flex-wrap gap-1.5">
              <select value={d.model} onChange={(e) => set({ model: e.target.value })} className={`${field} w-auto`}>
                {(MODELS.includes(d.model) ? MODELS : [...MODELS, d.model]).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input value={d.tools.join(', ')} onChange={(e) => set({ tools: e.target.value.split(',').map((t) => t.trim()) })} placeholder="Tools (comma-sep; empty = inherit all)" className={`${field} min-w-[12rem] flex-1`} />
            </div>
            <div>
              <select value={d.role || ''} onChange={(e) => set({ role: e.target.value || null })} className={field} aria-label="Role">
                <option value="">Role: automatic ({effectiveRole({ ...d, role: null }, coreNames)})</option>
                {(roles?.roles.map((r) => r.role) ?? []).map((r) => <option key={r} value={r}>Role: {r}</option>)}
              </select>
              <p className="mt-0.5 text-[10px] leading-snug text-[var(--text-muted)]">
                {roleInfo(effectiveRole(d, coreNames))?.summary ?? 'The role decides what the agent may do: where it can write and which checks run after it.'}
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
          {yours && mine.length === 0 && !d && <p className="text-[11px] text-[var(--text-muted)]">No agents of your own yet. Fork a built-in or create one.</p>}
          {mine.map((r) => (
            <div key={r.name} className={`${card} ${r.enabled ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-2">
                <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">
                  {r.name}{r.enabled && status?.(r.name)}
                  {r.forked_from && <span className="text-[10px] font-normal text-[var(--text-secondary)]">{coreNames.has(r.forked_from) ? <>forked from <span className="capitalize">{r.forked_from}</span></> : <>from {originLabel(r.forked_from)}</>}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {onSetEnabled && <button className={link} onClick={() => onSetEnabled(r.name, !r.enabled)}>{r.enabled ? 'Disable' : 'Enable'}</button>}
                  {onSave && <button className={link} onClick={() => setEditing({ isNew: false, draft: { name: r.name, description: r.description, prompt: r.prompt, model: r.model, tools: r.tools || [], forked_from: r.forked_from, role: r.role } })}>Edit</button>}
                  {onDelete && <ArmedDelete onConfirm={() => onDelete(r.name)} />}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--text-secondary)]">{r.description}</p>
              <RoleLine role={rowRole(r)} behaviours={roleInfo(rowRole(r))?.behaviours} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function SkillStore({ skills, onView, onFork, onRemove }: {
  skills: SkillInfo[]
  onView?: (folder: string) => void
  onFork?: (folder: string, newName: string) => void
  onRemove?: (folder: string) => void
}) {
  const [forking, setForking] = useState<{ from: string; to: string } | null>(null)
  const folderOf = (s: SkillInfo) => s.folder || agentName(s.name)
  const taken = new Set(skills.map(folderOf))
  const builtIn = skills.filter((s) => s.core)
  const mine = skills.filter((s) => !s.core)
  const forkName = forking ? agentName(forking.to) : ''
  const forkError = forking && (!forkName ? 'Name required' : taken.has(forkName) ? `${forkName} already exists` : '')

  const row = (s: SkillInfo, actions: ReactNode) => (
    <div key={folderOf(s)} className={card}>
      <div className="flex items-start justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium leading-snug text-[var(--text-primary)]">
          {s.name}{s.core && <LockBadge />}
          {s.forkedFrom && <span className="text-[10px] font-normal text-[var(--text-secondary)]">forked from {s.forkedFrom}</span>}
          {s.installedFrom && <span title={`${s.installedFrom.repo}@${s.installedFrom.sha}`} className="text-[10px] font-normal text-[var(--text-secondary)]">from {s.installedFrom.repo} @{s.installedFrom.sha.slice(0, 7)}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {onView && <button className={link} onClick={() => onView(folderOf(s))}>View</button>}
          {actions}
        </span>
      </div>
      {s.description && <p className="truncate text-[11px] text-[var(--text-secondary)]">{s.description}</p>}
      {forking?.from === folderOf(s) && (
        <div className="mt-2 flex items-center gap-1.5">
          <input value={forking.to} onChange={(e) => setForking({ ...forking, to: e.target.value })} className={`${field} flex-1`} placeholder="new-skill-name" />
          <button disabled={!!forkError} className={link} onClick={() => { onFork?.(forking.from, forkName); setForking(null) }}>Save copy</button>
          <button className={link} onClick={() => setForking(null)}>Cancel</button>
        </div>
      )}
      {forking?.from === folderOf(s) && forkError && <p className="mt-1 text-[10px] text-red-400">{forkError}</p>}
    </div>
  )

  return (
    <div className="space-y-4">
      {builtIn.length > 0 && (
        <div>
          <h5 className={heading}>Built in — maintained by Voice Native</h5>
          <div className="space-y-1.5">
            {builtIn.map((s) => row(s, onFork && (
              <button className={link} onClick={() => setForking({ from: folderOf(s), to: uniqueName(`my-${folderOf(s)}`, taken) })}>Fork</button>
            )))}
          </div>
        </div>
      )}
      <div>
        <h5 className={heading}>Yours</h5>
        <div className="space-y-1.5">
          {mine.length === 0 && <p className="text-[11px] text-[var(--text-muted)]">No skills of your own yet.</p>}
          {mine.map((s) => row(s, onRemove && <ArmedDelete label="Remove" onConfirm={() => onRemove(folderOf(s))} />))}
        </div>
      </div>
    </div>
  )
}
