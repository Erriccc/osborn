'use client'

// Outputs: what Osborn made for you, in the right-side drawer (replaces the
// full-screen Files Explorer as the default surface; UI#17). Chat and voice
// controls stay visible. The full-screen view is reachable only via "Expand".
// The project code tree is NOT here; it belongs with the code/diff view (L16).
import { useEffect, useMemo, useState } from 'react'
import { registerTab, type PanelTabProps } from './registry'
import { usePanelData, type PanelData } from './PanelDataContext'
import { JustMade } from './outputs/JustMade'
import { OutputRow } from './outputs/OutputRow'
import { FilePreview } from './outputs/FilePreview'
import { FavoriteRecovery } from './outputs/FavoriteRecovery'
import {
  groupOutputs, groupByProject, searchOutputs, summarize, isNew, fmtSynced, projectOf,
  type OutputFile,
} from '@/lib/outputs-model'
import type { GeneratedFile } from '../voice/shared'

function Section({ title, hint, files, render }: { title: string; hint?: string; files: OutputFile[]; render: (f: OutputFile) => React.ReactNode }) {
  if (files.length === 0) return null
  return (
    <section aria-label={title}>
      <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-900 sticky top-0 z-10" title={hint}>
        {title}
      </div>
      {files.map(render)}
    </section>
  )
}

/** Re-render every `ms` while `enabled` (the tab is on screen); no timer for
 *  a hidden tab. */
function useTick(ms: number, enabled: boolean) {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms, enabled])
}

export function OutputsTab({ active }: PanelTabProps) {
  const { generatedFiles, sessionId, outputs } = usePanelData()
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'recent' | 'project'>('recent')
  useTick(15_000, active) // keeps "Synced 12s ago" and relative times fresh

  const files = generatedFiles as OutputFile[]
  const pinned = outputs.pinnedPaths
  const previewFile = outputs.previewPath ? files.find((f) => f.filePath === outputs.previewPath) || null : null

  const groups = useMemo(
    () => groupOutputs(files, { now: Date.now(), sessionId, joinedAt: outputs.joinedAt, pinnedPaths: pinned }),
    [files, sessionId, outputs.joinedAt, pinned],
  )
  const search = useMemo(() => (query.trim() ? searchOutputs(files, query) : null), [files, query])
  const projects = useMemo(() => (view === 'project' ? groupByProject(files) : []), [files, view])

  const open = (f: OutputFile) => outputs.openPreview(f.filePath)
  const pin = (f: OutputFile) => outputs.togglePin(f as GeneratedFile)
  const row = (f: OutputFile, subtitle?: string | null) => (
    <OutputRow key={f.filePath} file={f} pinned={pinned.has(f.filePath)} isNew={isNew(f, outputs.seenAt)}
      subtitle={subtitle === undefined ? summarize(f) : subtitle} selected={outputs.previewPath === f.filePath}
      onOpen={open} onTogglePin={pin} />
  )

  if (!active) return null

  const header = (
    <div className="px-3 py-2 border-b border-gray-800 flex flex-col gap-2 shrink-0">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
            placeholder="Search names and contents" aria-label="Search outputs"
            className="w-full pl-8 pr-7 py-1.5 text-base sm:text-sm bg-gray-800/60 border border-gray-700/50 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:border-[var(--accent)]/50" />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-200">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>
        <button onClick={outputs.expand} title="Expand to full screen" aria-label="Expand outputs"
          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" /></svg>
        </button>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-500">
        <div role="tablist" aria-label="Outputs view" className="flex rounded-md bg-gray-800/60 p-0.5">
          {(['recent', 'project'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
              className={`px-2 py-0.5 rounded ${view === v ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
              {v === 'recent' ? 'Recent' : 'By project'}
            </button>
          ))}
        </div>
        <span className="ml-auto" data-testid="outputs-synced">
          {outputs.syncing ? 'Syncing…' : outputs.syncError ? "Couldn't sync" : fmtSynced(outputs.lastSyncedAt)}
        </span>
        <button onClick={outputs.refresh} disabled={outputs.syncing || !sessionId}
          className="px-2 py-0.5 rounded border border-gray-700 text-gray-300 hover:border-amber-500/40 disabled:opacity-40" aria-label="Refresh outputs">
          {outputs.syncError ? 'Retry' : 'Refresh'}
        </button>
      </div>
      {outputs.pinError && (
        <div role="alert" className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-[11px] text-red-300">
          <span className="flex-1">{outputs.pinError}</span>
          <button onClick={outputs.retryPin} className="underline hover:text-red-200">Retry</button>
          <button onClick={outputs.dismissPinError} aria-label="Dismiss" className="hover:text-red-200">×</button>
        </div>
      )}
    </div>
  )

  if (previewFile) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 shrink-0">
          <button onClick={() => outputs.openPreview(null)} className="flex items-center gap-1 text-xs text-gray-400 hover:text-white" aria-label="Back to outputs">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Outputs
          </button>
          <span className="flex-1 min-w-0 text-xs font-mono text-[var(--accent)] truncate" title={previewFile.filePath}>{previewFile.fileName}</span>
          <button onClick={() => pin(previewFile)}
            className={`px-2 py-1 text-xs rounded ${pinned.has(previewFile.filePath) ? 'text-amber-300 bg-amber-500/15' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
            {pinned.has(previewFile.filePath) ? 'Pinned' : 'Pin'}
          </button>
          {!previewFile.isImage && typeof previewFile.content === 'string' && previewFile.content.length > 0 && (
            <button onClick={() => outputs.copyFile(previewFile.filePath)}
              className={`px-2 py-1 text-xs rounded ${outputs.copyFeedback === previewFile.filePath ? 'bg-green-500/20 text-green-400' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}>
              {outputs.copyFeedback === previewFile.filePath ? 'Copied!' : 'Copy'}
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <FavoriteRecovery file={previewFile} pinned={pinned.has(previewFile.filePath)}
            onRemove={() => outputs.removeFavorite(previewFile as GeneratedFile)}
            onRegenerate={() => outputs.regenerateFile(previewFile as GeneratedFile)} />
          <FilePreview file={previewFile} compact onRetry={() => outputs.reloadFile(previewFile.filePath)} />
        </div>
      </div>
    )
  }

  const recentEmpty = files.length === 0
  const where = sessionId ? (() => {
    const sample = files.find((f) => f.filePath.includes(`/osb/${sessionId}/`))
    const p = sample ? projectOf(sample.filePath).project : null
    return `${p ? `${p} / ` : ''}${sessionId.slice(0, 8)}`
  })() : null

  return (
    <div className="flex flex-col h-full min-h-0">
      {header}
      <div className="flex-1 overflow-y-auto min-h-0" data-testid="outputs-list">
        {search ? (
          search.byName.length === 0 && search.byContent.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-gray-500">
              <span>No files named &ldquo;{query.trim()}&rdquo;, and no loaded file mentions it.</span>
              <button onClick={() => setQuery('')} className="px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-200 hover:border-amber-500/40">Clear filter</button>
            </div>
          ) : (
            <>
              <Section title="Names" files={search.byName} render={(f) => row(f)} />
              {search.byContent.length > 0 && (
                <section aria-label="Matches in contents">
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-900 sticky top-0 z-10">Matches in contents</div>
                  {search.byContent.map((m) => row(m.file, m.snippet))}
                </section>
              )}
            </>
          )
        ) : recentEmpty ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-gray-500">
            <span className="text-sm">No files in this session yet</span>
            <span className="text-xs text-gray-600 max-w-xs">Notes, plans, diagrams and pages Osborn writes for you show up here as they are made.</span>
          </div>
        ) : view === 'project' ? (
          projects.map((p) => (
            <section key={p.project} aria-label={p.project}>
              <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-900 sticky top-0 z-10">{p.project}</div>
              {p.sessions.map((s) => (
                <div key={s.session ?? 'none'}>
                  {s.session && <div className="px-3 pt-1.5 text-[10px] font-mono text-gray-600">session {s.session}</div>}
                  {s.files.map((f) => row(f))}
                </div>
              ))}
            </section>
          ))
        ) : (
          <>
            <JustMade files={groups.justMade} seenAt={outputs.seenAt} pinnedPaths={pinned} selectedPath={outputs.previewPath} onOpen={open} onTogglePin={pin} />
            <Section title="Pinned" hint="Pinned across sessions and devices" files={groups.pinned} render={(f) => row(f)} />
            <Section title="Today" files={groups.today} render={(f) => row(f)} />
            <Section title="Yesterday" files={groups.yesterday} render={(f) => row(f)} />
            <Section title="This week" files={groups.thisWeek} render={(f) => row(f)} />
            <Section title="Older" files={groups.older} render={(f) => row(f)} />
          </>
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-gray-800 flex items-center gap-2 text-[10px] text-gray-600 shrink-0">
        <span className="truncate" title="Where these session notes live">{where ? `Session notes · ${where}` : 'Session notes'}</span>
        {files.length > 0 && (
          <button onClick={outputs.copyAll} className="ml-auto px-1.5 py-0.5 rounded hover:text-gray-300">
            {outputs.copyFeedback === 'all' ? 'Copied!' : 'Copy all'}
          </button>
        )}
      </div>
    </div>
  )
}

function OutputsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  )
}

registerTab({
  id: 'outputs',
  label: 'Outputs',
  icon: OutputsIcon,
  component: OutputsTab,
  badge: (d: PanelData) => d.outputs.unseenCount || null,
  order: 0,
})
