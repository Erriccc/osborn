'use client'

// "Just made": files Osborn wrote in this session since you joined, newest
// first, each with a one-line summary (file-explorer report, build step 2).
import { summarize, isNew, type OutputFile } from '@/lib/outputs-model'
import { OutputRow } from './OutputRow'

export function JustMade({
  files, seenAt, pinnedPaths, selectedPath, onOpen, onTogglePin,
}: {
  files: OutputFile[]
  seenAt: number
  pinnedPaths: ReadonlySet<string>
  selectedPath: string | null
  onOpen: (file: OutputFile) => void
  onTogglePin: (file: OutputFile) => void
}) {
  if (files.length === 0) return null
  return (
    <section aria-label="Just made" data-testid="outputs-just-made">
      <div className="px-3 py-1.5 text-[10px] font-semibold text-amber-300/90 uppercase tracking-wider bg-gray-900 sticky top-0 z-10 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" aria-hidden="true" />
        Just made
      </div>
      {files.map((f) => (
        <OutputRow key={f.filePath} file={f} pinned={pinnedPaths.has(f.filePath)} isNew={isNew(f, seenAt)}
          subtitle={summarize(f)} selected={selectedPath === f.filePath} onOpen={onOpen} onTogglePin={onTogglePin} />
      ))}
    </section>
  )
}
