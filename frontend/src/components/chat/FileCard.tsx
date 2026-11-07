'use client'

// In-chat card for a file Osborn just wrote: name, one-line summary, Open.
// The file arrives where the work happened (file-explorer report, step 2);
// Open shows it in the Outputs drawer without hiding the conversation.
import { useOptionalPanelData } from '../panel/PanelDataContext'
import { summarize, type OutputFile } from '@/lib/outputs-model'
import { TYPE_BADGE, prettyTitle } from '../panel/outputs/OutputRow'

export function FileCard({ filePath, fileName }: { filePath: string; fileName: string }) {
  const data = useOptionalPanelData()
  const file = (data?.generatedFiles.find((f) => f.filePath === filePath) || null) as OutputFile | null
  const summary = file ? summarize(file) : null
  const badge = TYPE_BADGE[file?.type || 'other'] || TYPE_BADGE.other
  const title = prettyTitle(fileName) || fileName
  return (
    <div className="flex w-full py-1" data-testid="file-card" data-file-path={filePath}>
      <div className="hidden sm:block w-7 mr-2.5 shrink-0" aria-hidden="true" />
      <div className="flex items-center gap-3 max-w-md w-full rounded-xl border border-gray-700/60 bg-gray-800/40 px-3 py-2">
        <svg className="w-5 h-5 shrink-0 text-amber-400/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className={`px-1 py-0 text-[9px] font-bold rounded shrink-0 ${badge.color}`}>{badge.label}</span>
            <span className="text-xs font-medium text-gray-100 truncate" title={fileName}>{title}</span>
          </span>
          <span className="text-[11px] text-gray-400 truncate">{summary || `Osborn saved ${fileName}`}</span>
        </div>
        {data && (
          <button onClick={() => data.panel.openFile(filePath)}
            className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25">
            Open
          </button>
        )}
      </div>
    </div>
  )
}
