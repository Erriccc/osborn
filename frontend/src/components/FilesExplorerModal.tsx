'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { MarkdownMessage } from './MarkdownMessage'

// Matches GeneratedFile from VoiceRoom.tsx
interface GeneratedFile {
  filePath: string
  fileName: string
  content?: string
  type: 'plan' | 'diagram' | 'notes' | 'image' | 'summary' | 'other'
  source: 'plan' | 'research'
  updatedAt: Date
  isImage?: boolean
  mimeType?: string
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
}

const typeBadge: Record<string, { label: string; color: string }> = {
  plan: { label: 'Plan', color: 'bg-violet-500/20 text-violet-400' },
  diagram: { label: 'Diagram', color: 'bg-blue-500/20 text-blue-400' },
  notes: { label: 'Notes', color: 'bg-emerald-500/20 text-emerald-400' },
  image: { label: 'Image', color: 'bg-amber-500/20 text-amber-400' },
  summary: { label: 'Summary', color: 'bg-cyan-500/20 text-cyan-400' },
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
}: FilesExplorerModalProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [isMaximized, setIsMaximized] = useState(false)

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

  // Group filtered files by source
  const planFiles = useMemo(() => filteredFiles.filter(f => f.source === 'plan'), [filteredFiles])
  const researchFiles = useMemo(() => filteredFiles.filter(f => f.source === 'research'), [filteredFiles])

  // Currently selected file
  const selectedFile = useMemo(
    () => files.find(f => f.filePath === selectedFilePath) || files[0] || null,
    [files, selectedFilePath]
  )

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        className={`flex flex-col bg-gray-900 border border-gray-700/50 shadow-2xl rounded-2xl overflow-hidden transition-all duration-200 ${
          isMaximized
            ? 'w-[95vw] h-[95vh]'
            : 'w-[80vw] max-w-5xl h-[75vh]'
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
          <div className="w-64 shrink-0 flex flex-col border-r border-gray-700/50 bg-gray-900/50">
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
                  {planFiles.length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-800/30 sticky top-0">
                        Plans
                      </div>
                      {planFiles.map((file) => (
                        <FileListItem
                          key={file.filePath}
                          file={file}
                          isSelected={selectedFile?.filePath === file.filePath}
                          onSelect={onSelectFile}
                        />
                      ))}
                    </div>
                  )}
                  {researchFiles.length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-800/30 sticky top-0">
                        Research
                      </div>
                      {researchFiles.map((file) => (
                        <FileListItem
                          key={file.filePath}
                          file={file}
                          isSelected={selectedFile?.filePath === file.filePath}
                          onSelect={onSelectFile}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right column: content preview */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedFile ? (
              <>
                {/* File header */}
                <div className="flex items-center justify-between px-5 py-2.5 bg-gray-800/50 border-b border-gray-700/30 shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
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

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5">
                  {selectedFile.content ? (
                    selectedFile.isImage ? (
                      <img
                        src={`data:${selectedFile.mimeType || 'image/png'};base64,${selectedFile.content}`}
                        alt={selectedFile.fileName}
                        className="max-w-full rounded-lg border border-gray-700"
                      />
                    ) : selectedFile.type === 'diagram' ? (
                      <pre className="text-xs text-gray-300 bg-gray-800/60 rounded-lg p-4 overflow-x-auto font-mono whitespace-pre-wrap">{selectedFile.content}</pre>
                    ) : (
                      <div className="text-sm">
                        <MarkdownMessage content={selectedFile.content} />
                      </div>
                    )
                  ) : (
                    <div className="flex items-center justify-center py-12 text-gray-500 text-xs">
                      <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Loading content...
                    </div>
                  )}
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
}: {
  file: GeneratedFile
  isSelected: boolean
  onSelect: (filePath: string) => void
}) {
  const badge = typeBadge[file.type] || typeBadge.other

  return (
    <button
      onClick={() => onSelect(file.filePath)}
      className={`w-full text-left px-3 py-2.5 flex items-center gap-2 transition-colors ${
        isSelected
          ? 'bg-violet-500/15 border-l-2 border-violet-400'
          : 'hover:bg-gray-800/50 border-l-2 border-transparent'
      }`}
    >
      <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded shrink-0 ${badge.color}`}>{badge.label}</span>
      <span className="text-xs font-mono text-gray-300 truncate flex-1">{file.fileName}</span>
      {!file.content && (
        <svg className="w-3 h-3 animate-spin text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
    </button>
  )
}

export default FilesExplorerModal
