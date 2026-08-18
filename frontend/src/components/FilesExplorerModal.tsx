'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { MarkdownMessage, MermaidBlock } from './MarkdownMessage'

// Matches GeneratedFile from VoiceRoom.tsx
interface GeneratedFile {
  filePath: string
  fileName: string
  content?: string
  // Supabase Storage URL — when present, fetch from here instead of rendering
  // inline content. Agent uploads large artifacts (PDFs, big text files) to
  // Supabase and passes just the URL through the data channel.
  url?: string
  type: 'plan' | 'diagram' | 'notes' | 'image' | 'summary' | 'html' | 'other'
  source: 'plan' | 'research'
  updatedAt: Date
  isImage?: boolean
  mimeType?: string
  truncated?: boolean
  originalSize?: number
}

interface FilesExplorerModalProps {
  isOpen: boolean
  onClose: () => void
  files: GeneratedFile[]
  selectedFilePath: string | null
  onSelectFile: (filePath: string) => void
  onCopyFile: (filePath: string) => void
  onCopyAll: () => void
  fileCopyFeedback: string | null
  // Favorites — a durable, user-pinned subset. favoritePaths holds the filePath
  // of each starred file; onToggleFavorite flips one. Optional so the modal
  // still works if a caller doesn't wire favorites.
  favoritePaths?: Set<string>
  onToggleFavorite?: (file: GeneratedFile) => void
}

const typeBadge: Record<string, { label: string; color: string }> = {
  plan: { label: 'Plan', color: 'bg-violet-500/20 text-violet-400' },
  diagram: { label: 'Diagram', color: 'bg-blue-500/20 text-blue-400' },
  notes: { label: 'Notes', color: 'bg-emerald-500/20 text-emerald-400' },
  image: { label: 'Image', color: 'bg-amber-500/20 text-amber-400' },
  summary: { label: 'Summary', color: 'bg-cyan-500/20 text-cyan-400' },
  html: { label: 'HTML', color: 'bg-orange-500/20 text-orange-400' },
  other: { label: 'File', color: 'bg-gray-500/20 text-gray-400' },
}

export function FilesExplorerModal({
  isOpen,
  onClose,
  files,
  selectedFilePath,
  onSelectFile,
  onCopyFile,
  onCopyAll,
  fileCopyFeedback,
  favoritePaths,
  onToggleFavorite,
}: FilesExplorerModalProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [isMaximized, setIsMaximized] = useState(false)
  const [mobileView, setMobileView] = useState<'list' | 'content'>('list')

  // Reset mobile view when modal closes
  useEffect(() => {
    if (!isOpen) setMobileView('list')
  }, [isOpen])

  // Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  // Filter files by search query
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files
    const q = searchQuery.toLowerCase()
    return files.filter(
      f => f.fileName.toLowerCase().includes(q) || f.type.toLowerCase().includes(q)
    )
  }, [files, searchQuery])

  const isFav = useCallback((fp: string) => !!favoritePaths?.has(fp), [favoritePaths])

  // Favorites pin to the top in their own section; the source groups below then
  // exclude them so a starred file isn't listed twice.
  const favoriteFilesList = useMemo(() => filteredFiles.filter(f => isFav(f.filePath)), [filteredFiles, isFav])
  const planFiles = useMemo(() => filteredFiles.filter(f => f.source === 'plan' && !isFav(f.filePath)), [filteredFiles, isFav])
  const researchFiles = useMemo(() => filteredFiles.filter(f => f.source === 'research' && !isFav(f.filePath)), [filteredFiles, isFav])
  const otherFiles = useMemo(() => filteredFiles.filter(f => f.source !== 'plan' && f.source !== 'research' && !isFav(f.filePath)), [filteredFiles, isFav])

  // Currently selected file
  const selectedFile = useMemo(
    () => files.find(f => f.filePath === selectedFilePath) || files[0] || null,
    [files, selectedFilePath]
  )

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  const handleSelectFile = useCallback((filePath: string) => {
    onSelectFile(filePath)
    setMobileView('content')
  }, [onSelectFile])

  // When the selected file has a Supabase URL but no inline content, fetch
  // the text once and cache it keyed by URL. PDFs and images render from
  // the URL directly via <iframe>/<img> — no fetch needed — so we only
  // fetch for text-like files that need MarkdownMessage rendering.
  const [urlContentCache, setUrlContentCache] = useState<Record<string, string>>({})
  const [urlFetching, setUrlFetching] = useState<string | null>(null)
  useEffect(() => {
    const sel = files.find(f => f.filePath === selectedFilePath) || files[0] || null
    if (!sel?.url) return
    if (sel.content) return                       // already have inline content
    if (urlContentCache[sel.url]) return          // already fetched
    if (sel.isImage) return                       // <img src={url}> handles it
    const ext = sel.fileName.split('.').pop()?.toLowerCase() || ''
    if (ext === 'pdf') return                     // <iframe src={url}> handles it
    setUrlFetching(sel.url)
    fetch(sel.url)
      .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(text => setUrlContentCache(prev => ({ ...prev, [sel.url!]: text })))
      .catch(err => setUrlContentCache(prev => ({ ...prev, [sel.url!]: `Error fetching: ${(err as Error).message}` })))
      .finally(() => setUrlFetching(null))
  }, [files, selectedFilePath, urlContentCache])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        className={`flex flex-col bg-gray-900 border border-gray-700/50 shadow-2xl overflow-hidden transition-all duration-200 ${
          isMaximized
            ? 'w-[95vw] h-[95vh] rounded-2xl'
            : 'w-full h-full rounded-none sm:rounded-2xl sm:w-[80vw] sm:max-w-5xl sm:h-[75vh]'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700/50 bg-gray-900/80 shrink-0">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span className="text-sm font-semibold text-white">Files Explorer</span>
            <span className="text-xs text-gray-500">({files.length})</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Copy All */}
            {files.filter(f => !f.isImage).length > 1 && (
              <button
                onClick={onCopyAll}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  fileCopyFeedback === 'all'
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
              >
                {fileCopyFeedback === 'all' ? 'Copied!' : 'Copy All'}
              </button>
            )}
            {/* Maximize / Restore */}
            <button
              onClick={() => setIsMaximized(!isMaximized)}
              className="p-1.5 text-gray-400 hover:text-white rounded transition-colors"
              title={isMaximized ? 'Restore' : 'Maximize'}
            >
              {isMaximized ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V5a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-4M15 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2h4" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                </svg>
              )}
            </button>
            {/* Close */}
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-white rounded transition-colors"
              title="Close (Esc)"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body: two-column layout */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left column: file list */}
          <div className={`${mobileView === 'list' ? 'flex' : 'hidden'} sm:flex w-full sm:w-64 shrink-0 flex-col border-r border-gray-700/50 bg-gray-900/50`}>
            {/* Search */}
            <div className="p-3 border-b border-gray-700/30">
              <div className="relative">
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter files..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-gray-800/60 border border-gray-700/50 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20"
                />
              </div>
            </div>

            {/* File list */}
            <div className="flex-1 overflow-y-auto">
              {filteredFiles.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-2 p-4">
                  <span className="text-xs">{searchQuery ? 'No matches' : 'No files yet'}</span>
                </div>
              ) : (
                <>
                  {favoriteFilesList.length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-amber-400/80 uppercase tracking-wider bg-gray-900 sticky top-0 z-10 flex items-center gap-1.5">
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7L12 17.8 5.8 21.2l1.6-7L2 9.5l7.1-.6L12 2z" /></svg>
                        Favorites · stays saved
                      </div>
                      {favoriteFilesList.map((file) => (
                        <FileListItem
                          key={file.filePath}
                          file={file}
                          isSelected={selectedFile?.filePath === file.filePath}
                          onSelect={handleSelectFile}
                          isFavorite={isFav(file.filePath)}
                          onToggleFavorite={onToggleFavorite}
                        />
                      ))}
                    </div>
                  )}
                  {planFiles.length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-900 sticky top-0 z-10">
                        Plans
                      </div>
                      {planFiles.map((file) => (
                        <FileListItem
                          key={file.filePath}
                          file={file}
                          isSelected={selectedFile?.filePath === file.filePath}
                          onSelect={handleSelectFile}
                          isFavorite={isFav(file.filePath)}
                          onToggleFavorite={onToggleFavorite}
                        />
                      ))}
                    </div>
                  )}
                  {researchFiles.length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-900 sticky top-0 z-10">
                        Research
                      </div>
                      {researchFiles.map((file) => (
                        <FileListItem
                          key={file.filePath}
                          file={file}
                          isSelected={selectedFile?.filePath === file.filePath}
                          onSelect={handleSelectFile}
                          isFavorite={isFav(file.filePath)}
                          onToggleFavorite={onToggleFavorite}
                        />
                      ))}
                    </div>
                  )}
                  {otherFiles.length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-900 sticky top-0 z-10">
                        Other
                      </div>
                      {otherFiles.map((file) => (
                        <FileListItem
                          key={file.filePath}
                          file={file}
                          isSelected={selectedFile?.filePath === file.filePath}
                          onSelect={handleSelectFile}
                          isFavorite={isFav(file.filePath)}
                          onToggleFavorite={onToggleFavorite}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right column: content preview */}
          <div className={`${mobileView === 'content' ? 'flex' : 'hidden'} sm:flex flex-1 flex-col overflow-hidden`}>
            {selectedFile ? (
              <>
                {/* File header */}
                <div className="flex items-center justify-between px-5 py-2.5 bg-gray-800/50 border-b border-gray-700/30 shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Back button — mobile only */}
                    <button
                      onClick={() => setMobileView('list')}
                      className="sm:hidden flex items-center gap-1 text-xs text-gray-400 hover:text-white shrink-0 mr-1"
                      title="Back to files"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                      Files
                    </button>
                    <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded shrink-0 ${(typeBadge[selectedFile.type] || typeBadge.other).color}`}>
                      {(typeBadge[selectedFile.type] || typeBadge.other).label}
                    </span>
                    <span className="text-xs font-mono text-violet-300 truncate">{selectedFile.fileName}</span>
                  </div>
                  {!selectedFile.isImage && (
                    <button
                      onClick={() => onCopyFile(selectedFile.filePath)}
                      className={`px-2.5 py-1 text-xs rounded transition-colors shrink-0 ml-3 ${
                        fileCopyFeedback === selectedFile.filePath
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-gray-700 text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {fileCopyFeedback === selectedFile.filePath ? 'Copied!' : 'Copy'}
                    </button>
                  )}
                </div>

                {/* Content — URL path first, inline content path second */}
                <div className="flex-1 overflow-y-auto p-5">
                  {(() => {
                    const ext = selectedFile.fileName.split('.').pop()?.toLowerCase() || ''
                    // URL-based rendering: agent uploaded to Supabase, render from URL
                    if (selectedFile.url) {
                      if (selectedFile.isImage) {
                        return (
                          <img
                            src={selectedFile.url}
                            alt={selectedFile.fileName}
                            className="max-w-full rounded-lg border border-gray-700"
                          />
                        )
                      }
                      if (ext === 'pdf') {
                        return (
                          <iframe
                            src={selectedFile.url}
                            className="w-full h-full min-h-[600px] rounded-lg border border-gray-700 bg-gray-800"
                            title={selectedFile.fileName}
                          />
                        )
                      }
                      // Text-like: use cache if available, inline content as fallback.
                      // When a file is favorited mid-session, the URL is set but the
                      // useEffect skips fetching (sees content, returns early), so the
                      // cache stays empty and the spinner would loop forever without this.
                      const fetched = urlContentCache[selectedFile.url] ?? selectedFile.content
                      if (!fetched) {
                        return (
                          <div className="flex items-center justify-center py-12 text-gray-500 text-xs">
                            <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            Fetching from storage...
                          </div>
                        )
                      }
                      if (selectedFile.type === 'html' || ext === 'svg') {
                        return (
                          <iframe
                            srcDoc={ext === 'svg'
                              ? `<!DOCTYPE html><html><head><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#1a1a2e;overflow:hidden}svg{width:100%;height:100%;max-width:100vw;max-height:100vh}</style></head><body>${fetched}</body></html>`
                              : `<!DOCTYPE html><html><head><style>html{font-size:16px}body{margin:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#e2e8f0;background:#1a1a2e}table{border-collapse:collapse;width:100%}th,td{border:1px solid #475569;padding:8px 12px;text-align:left}th{background:#334155}h1,h2,h3{color:#f1f5f9}a{color:#60a5fa}code{background:#334155;padding:2px 6px;border-radius:4px;font-size:14px}pre{background:#0f172a;padding:16px;border-radius:8px;overflow-x:auto}</style></head><body>${fetched}</body></html>`}
                            className="w-full h-full min-h-[500px] rounded-lg border border-gray-700"
                            sandbox="allow-scripts"
                            title={selectedFile.fileName}
                          />
                        )
                      }
                      if (ext === 'mmd' || ext === 'mermaid') {
                        return <MermaidBlock code={fetched} />
                      }
                      return (
                        <div className="text-sm">
                          <MarkdownMessage content={fetched} />
                        </div>
                      )
                    }
                    // Inline content path (fallback — when URL upload wasn't available)
                    if (selectedFile.content) {
                      if (selectedFile.isImage) {
                        return (
                          <img
                            src={`data:${selectedFile.mimeType || 'image/png'};base64,${selectedFile.content}`}
                            alt={selectedFile.fileName}
                            className="max-w-full rounded-lg border border-gray-700"
                          />
                        )
                      }
                      if (selectedFile.type === 'html' || ext === 'svg') {
                        return (
                          <iframe
                            srcDoc={ext === 'svg'
                              ? `<!DOCTYPE html><html><head><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#1a1a2e;overflow:hidden}svg{width:100%;height:100%;max-width:100vw;max-height:100vh}</style></head><body>${selectedFile.content}</body></html>`
                              : `<!DOCTYPE html><html><head><style>html{font-size:16px}body{margin:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#e2e8f0;background:#1a1a2e}table{border-collapse:collapse;width:100%}th,td{border:1px solid #475569;padding:8px 12px;text-align:left}th{background:#334155}h1,h2,h3{color:#f1f5f9}a{color:#60a5fa}code{background:#334155;padding:2px 6px;border-radius:4px;font-size:14px}pre{background:#0f172a;padding:16px;border-radius:8px;overflow-x:auto}</style></head><body>${selectedFile.content}</body></html>`}
                            className="w-full h-full min-h-[500px] rounded-lg border border-gray-700"
                            sandbox="allow-scripts"
                            title={selectedFile.fileName}
                          />
                        )
                      }
                      if (ext === 'mmd' || ext === 'mermaid') {
                        return <MermaidBlock code={selectedFile.content} />
                      }
                      return (
                        <div className="text-sm">
                          {selectedFile.truncated && (
                            <div className="mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300">
                              Truncated preview &mdash; original {selectedFile.originalSize ? `${(selectedFile.originalSize / 1024).toFixed(0)} KB` : 'large'} (Supabase upload unavailable)
                            </div>
                          )}
                          <MarkdownMessage content={selectedFile.content} />
                        </div>
                      )
                    }
                    // No URL and no content — nothing to fetch (e.g. an older
                    // favorite saved before a durable copy existed). Don't spin
                    // forever; say so clearly.
                    return (
                      <div className="flex flex-col items-center justify-center py-12 text-center text-gray-500 text-xs gap-2 px-6">
                        <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                        </svg>
                        <div className="font-medium text-gray-400">No saved copy for this file</div>
                        <div className="max-w-xs leading-relaxed">This was favorited before a durable copy was stored, so its content isn&apos;t available here. Re-favorite it from the session that has it, and it&apos;ll sync everywhere.</div>
                      </div>
                    )
                  })()}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-3">
                <svg className="w-10 h-10 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span className="text-sm">Select a file to preview</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// File list item component
function FileListItem({
  file,
  isSelected,
  onSelect,
  isFavorite,
  onToggleFavorite,
}: {
  file: GeneratedFile
  isSelected: boolean
  onSelect: (filePath: string) => void
  isFavorite?: boolean
  onToggleFavorite?: (file: GeneratedFile) => void
}) {
  const badge = typeBadge[file.type] || typeBadge.other

  // Row is a div (not a button) so the star can be its own button without
  // nesting interactive elements. The name area stays keyboard-activatable.
  return (
    <div
      className={`w-full px-3 py-2.5 flex items-center gap-2 transition-colors ${
        isSelected
          ? 'bg-violet-500/15 border-l-2 border-violet-400'
          : 'hover:bg-gray-800/50 border-l-2 border-transparent'
      }`}
    >
      <button
        onClick={() => onSelect(file.filePath)}
        className="flex items-center gap-2 min-w-0 flex-1 text-left"
      >
        <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded shrink-0 ${badge.color}`}>{badge.label}</span>
        <span className="text-xs font-mono text-gray-300 truncate">{file.fileName}</span>
      </button>
      {/* Spinner only while we have neither content nor URL. */}
      {!file.content && !file.url && (
        <svg className="w-3 h-3 animate-spin text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(file) }}
          className={`shrink-0 p-1 rounded transition-colors ${
            isFavorite ? 'text-amber-400 hover:text-amber-300' : 'text-gray-600 hover:text-gray-300'
          }`}
          title={isFavorite ? 'Unfavorite — remove from pinned' : 'Favorite — keep this file pinned'}
          aria-label={isFavorite ? 'Unfavorite' : 'Favorite'}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7L12 17.8 5.8 21.2l1.6-7L2 9.5l7.1-.6L12 2z" />
          </svg>
        </button>
      )}
    </div>
  )
}

export default FilesExplorerModal
