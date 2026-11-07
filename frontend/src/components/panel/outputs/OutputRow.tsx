'use client'

// One Outputs row: type badge, title + literal filename (the agent says names
// aloud), one-line summary or folder, relative time, "New" pill. The star shows
// ONLY on pinned rows (UI#21); unpinned rows get an explicit "Pin" action.
import { fmtRelative, projectOf, type OutputFile } from '@/lib/outputs-model'

export const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  plan: { label: 'Plan', color: 'bg-violet-500/20 text-violet-400' },
  diagram: { label: 'Diagram', color: 'bg-blue-500/20 text-blue-400' },
  notes: { label: 'Notes', color: 'bg-emerald-500/20 text-emerald-400' },
  image: { label: 'Image', color: 'bg-amber-500/20 text-amber-400' },
  summary: { label: 'Summary', color: 'bg-cyan-500/20 text-cyan-400' },
  html: { label: 'HTML', color: 'bg-orange-500/20 text-orange-400' },
  other: { label: 'File', color: 'bg-gray-500/20 text-gray-400' },
}

export function prettyTitle(fileName: string): string | null {
  const base = fileName.replace(/\.[^.]+$/, '')
  const pretty = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!pretty || pretty === fileName || pretty === base) return null
  return pretty
}

export function OutputRow({
  file, pinned, isNew, subtitle, selected, onOpen, onTogglePin,
}: {
  file: OutputFile
  pinned: boolean
  isNew?: boolean
  /** Summary, content snippet, or null to show the folder. */
  subtitle?: string | null
  selected?: boolean
  onOpen: (file: OutputFile) => void
  onTogglePin?: (file: OutputFile) => void
}) {
  const badge = TYPE_BADGE[file.type] || TYPE_BADGE.other
  const pretty = prettyTitle(file.fileName)
  const { project, session } = projectOf(file.filePath)
  const where = session ? `${project} / ${session}` : project
  const rel = fmtRelative(file.updatedAt)
  return (
    <div data-testid="output-row" data-file-path={file.filePath}
      className={`group w-full min-h-[44px] px-3 py-2 flex items-start gap-2 transition-colors motion-reduce:transition-none ${
        selected ? 'bg-[var(--accent)]/15 border-l-2 border-[var(--accent)]' : 'hover:bg-gray-800/50 border-l-2 border-transparent'
      }`}>
      <button onClick={() => onOpen(file)} title={file.filePath}
        className="flex items-start gap-2 min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded">
        <span className={`mt-0.5 px-1.5 py-0.5 text-[9px] font-bold rounded shrink-0 ${badge.color}`}>{badge.label}</span>
        <span className="flex flex-col min-w-0">
          <span className="text-xs font-medium text-gray-200 truncate">{pretty || file.fileName}</span>
          {pretty && <span className="text-[10px] font-mono text-gray-500 truncate">{file.fileName}</span>}
          <span className="text-[11px] text-gray-500 truncate">{subtitle || where}</span>
        </span>
      </button>
      <span className="shrink-0 flex items-center gap-1.5 pt-0.5">
        {isNew && <span className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-[9px] font-semibold uppercase tracking-wide">New</span>}
        {rel && <span className="text-[10px] text-gray-500 tabular-nums" title={new Date(file.updatedAt).toLocaleString()}>{rel}</span>}
        {onTogglePin && (pinned ? (
          <button onClick={(e) => { e.stopPropagation(); onTogglePin(file) }}
            className="p-1 rounded text-amber-400 hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            title="Unpin" aria-label={`Unpin ${file.fileName}`} aria-pressed="true">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7L12 17.8 5.8 21.2l1.6-7L2 9.5l7.1-.6L12 2z" />
            </svg>
          </button>
        ) : (
          <button onClick={(e) => { e.stopPropagation(); onTogglePin(file) }}
            className="px-1.5 py-0.5 rounded text-[10px] text-gray-500 hover:text-gray-200 hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
            title="Pin — keep this file across sessions and devices" aria-label={`Pin ${file.fileName}`}>
            Pin
          </button>
        ))}
      </span>
    </div>
  )
}
