'use client'

import React, { useState, useRef } from 'react'
import type { ApprovalMode } from './PermissionModal'

const APPROVAL_MODES: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask me', hint: 'Pause and ask before each tool action (default)' },
  { value: 'auto-review', label: 'Auto-review', hint: 'Show full details up front for a fast decision — still asks before each action' },
  { value: 'allow-all', label: 'Allow all', hint: 'Approve every tool action for this session (resets on reload)' },
]

export interface AttachedFile {
  file: File
  preview?: string
  type: 'image' | 'file'
  uploadStatus?: 'pending' | 'uploading' | 'uploaded' | 'error'
  uploadedUrl?: string
  uploadError?: string
}

export function TextInput({
  onSend,
  attachedFiles,
  onAttachFile,
  onRemoveFile,
  approvalMode,
  onApprovalModeChange,
}: {
  onSend: (text: string, files?: AttachedFile[]) => void
  attachedFiles: AttachedFile[]
  onAttachFile: (files: FileList) => void
  onRemoveFile: (index: number) => void
  // Session-scoped tool-approval mode (NOT persisted — resets each session).
  approvalMode?: ApprovalMode
  onApprovalModeChange?: (mode: ApprovalMode) => void
}) {
  const [text, setText] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (text.trim() || attachedFiles.length > 0) {
      onSend(text.trim(), attachedFiles.length > 0 ? attachedFiles : undefined)
      setText('')
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAttachFile(e.target.files)
    }
    e.target.value = ''
  }

  // Paste an image straight from the clipboard (e.g. a screenshot) into the
  // composer -- routes through the same onAttachFile path the file picker uses,
  // so upload + preview behave identically. Only intercepts when the clipboard
  // carries image files; plain-text paste is untouched.
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) imageFiles.push(f)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      const dt = new DataTransfer()
      imageFiles.forEach((f) => dt.items.add(f))
      onAttachFile(dt.files)
    }
  }

  return (
    <div className="border-t border-gray-800/50 bg-gray-900/50 backdrop-blur-sm">
      {/* Attached files preview */}
      {attachedFiles.length > 0 && (
        <div className="flex gap-2 p-3 pb-0 overflow-x-auto">
          {attachedFiles.map((af, idx) => (
            <div key={idx} className="relative group shrink-0">
              {af.type === 'image' && af.preview ? (
                <img
                  src={af.preview}
                  alt={af.file.name}
                  className={`h-14 w-14 object-cover rounded-lg border shadow-md ${
                    af.uploadStatus === 'uploaded' ? 'border-green-500' :
                    af.uploadStatus === 'uploading' ? 'border-yellow-500 animate-pulse' :
                    af.uploadStatus === 'error' ? 'border-red-500' : 'border-gray-700'
                  }`}
                />
              ) : (
                <div className={`h-14 w-14 bg-gray-800 rounded-lg border flex items-center justify-center shadow-md ${
                  af.uploadStatus === 'uploaded' ? 'border-green-500' :
                  af.uploadStatus === 'uploading' ? 'border-yellow-500 animate-pulse' :
                  af.uploadStatus === 'error' ? 'border-red-500' : 'border-gray-700'
                }`}>
                  <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
              )}
              {/* Upload status indicator */}
              {af.uploadStatus === 'uploading' && (
                <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                  <svg className="w-5 h-5 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              )}
              {af.uploadStatus === 'uploaded' && (
                <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
              {af.uploadStatus === 'error' && (
                <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center" title={af.uploadError}>
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
              )}
              <button
                onClick={() => onRemoveFile(idx)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 max-sm:w-6 max-sm:h-6 bg-red-500 rounded-full text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity shadow-md hover:bg-red-600"
                aria-label="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Approval-mode picker — the single, visible, session-scoped control that
          replaces the three hidden auto-approve toggles. NOT persisted: it
          resets to "Ask me" on every reload, so there is no lingering,
          invisible blanket "Allow". Only "Allow all" auto-approves; it is
          session-scoped and warns once on first use. */}
      {approvalMode && onApprovalModeChange && (
        <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 shrink-0">Approvals</span>
          <div className="flex items-center gap-0.5 rounded-full bg-gray-800/60 border border-gray-700/50 p-0.5 shrink-0">
            {APPROVAL_MODES.map((m) => {
              const active = approvalMode === m.value
              const activeCls = m.value === 'allow-all'
                ? 'bg-amber-500/90 text-gray-950'
                : 'bg-gray-700 text-white'
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => onApprovalModeChange(m.value)}
                  title={m.hint}
                  aria-pressed={active}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors ${
                    active ? activeCls : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Composer — pill input, integrated attach, accent send; safe-area
          padding so the iOS home indicator never crowds it. */}
      <form onSubmit={handleSubmit} className="p-2 sm:p-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h"
          onChange={handleFileSelect}
          className="hidden"
        />
        <div className="flex items-center gap-1.5 rounded-full bg-gray-800/60 border border-gray-700/50 focus-within:border-amber-500/50 focus-within:ring-2 focus-within:ring-amber-500/15 transition-all pl-1.5 pr-1.5 py-1 max-sm:py-1.5">
          {/* Attach — 44pt target on touch (P1.10) */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-2 max-sm:min-h-11 max-sm:min-w-11 flex items-center justify-center text-gray-500 hover:text-amber-300 rounded-full hover:bg-gray-700/50 active:scale-95 transition-all shrink-0"
            title="Attach file"
          >
            <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>

          {/* Text input — borderless inside the pill */}
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
            placeholder="Message Osborn…"
            className="flex-1 min-w-0 bg-transparent text-[15px] text-white px-1 py-2 focus:outline-none placeholder:text-gray-500"
          />

          {/* Send — 44pt target on touch (P1.10) */}
          <button
            type="submit"
            disabled={!text.trim() && attachedFiles.length === 0}
            className="w-9 h-9 max-sm:w-11 max-sm:h-11 flex items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-amber-600 hover:from-amber-500 hover:to-amber-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed active:scale-95 transition-all shadow-[0_2px_12px_rgba(245,158,11,0.35)] disabled:shadow-none shrink-0"
          >
            <svg className="w-4 h-4 text-gray-950" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m0 0l-6-6m6 6l-6 6" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  )
}
