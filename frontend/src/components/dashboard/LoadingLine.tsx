// The dashboard sections' loading row: shown instead of an empty-state message
// until the data that could fill the section has arrived.
export default function LoadingLine() {
  return (
    <div className="flex items-center gap-2 py-4" role="status">
      <span className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      <span className="text-[13px] text-[var(--text-muted)]">Loading…</span>
    </div>
  )
}
