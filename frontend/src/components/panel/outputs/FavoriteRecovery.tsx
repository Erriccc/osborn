'use client'

// Recovery bar for a pinned file without a durable copy (bug 55033541). Shared
// by the Outputs drawer and the expanded Files view. While the body is being
// fetched from the agent machine it says so; once that fails it offers the two
// ways out instead of a dead page.
import { favoriteCopyState, type OutputFile } from '@/lib/outputs-model'

export function FavoriteRecovery({ file, pinned, onRemove, onRegenerate }: {
  file: OutputFile
  pinned: boolean
  onRemove?: () => void
  onRegenerate?: () => void
}) {
  const state = favoriteCopyState(file, pinned)
  if (state === 'ok') return null
  if (state === 'recovering' || state === 'repairable') {
    return (
      <div role="status" data-testid="favorite-recovering"
        className="mb-3 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700/60 text-[11px] text-gray-400">
        {state === 'recovering'
          ? 'No saved copy yet. Looking for this file on your machine…'
          : 'Found it. Saving a copy so this favorite opens anywhere…'}
      </div>
    )
  }
  return (
    <div role="alert" data-testid="favorite-dead"
      className="mb-3 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-100">
      <div className="font-semibold text-amber-200">No saved copy of this favorite</div>
      <div className="mt-0.5 text-amber-100/80 leading-snug">
        It was pinned before copies were kept, and the file is no longer on your machine.
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {onRegenerate && (
          <button onClick={onRegenerate}
            className="px-2.5 py-1 rounded-md bg-amber-400 text-black text-[11px] font-semibold hover:bg-amber-300">
            Ask agent to regenerate
          </button>
        )}
        {onRemove && (
          <button onClick={onRemove}
            className="px-2.5 py-1 rounded-md bg-gray-800 border border-gray-700 text-gray-200 text-[11px] hover:border-amber-500/40">
            Remove from favorites
          </button>
        )}
      </div>
    </div>
  )
}
