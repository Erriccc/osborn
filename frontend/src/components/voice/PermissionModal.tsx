'use client'

import { useState } from 'react'

export interface PermissionRequest {
  toolName: string
  description: string
  input?: Record<string, unknown>
  riskLevel?: 'low' | 'medium' | 'high'
  diff?: string
}

// Helper to determine tool risk level
export function getToolRiskLevel(toolName: string): 'low' | 'medium' | 'high' {
  const highRisk = ['Bash', 'Write', 'Edit', 'NotebookEdit']
  const mediumRisk = ['WebFetch', 'Task', 'KillShell']
  if (highRisk.includes(toolName)) return 'high'
  if (mediumRisk.includes(toolName)) return 'medium'
  return 'low'
}

export function PermissionModal({
  permission,
  onRespond,
}: {
  permission: PermissionRequest
  onRespond: (response: 'allow' | 'deny' | 'always_allow') => void
}) {
  const riskColors = {
    low: 'text-green-400 bg-green-500/10 border-green-500/30',
    medium: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
    high: 'text-red-400 bg-red-500/10 border-red-500/30',
  }
  const riskLevel = permission.riskLevel || 'medium'
  const [showFullDiff, setShowFullDiff] = useState(false)

  // Extract key details from input for display
  const getInputDetails = () => {
    const input = permission.input
    if (!input) return null

    if (permission.toolName === 'Bash' && input.command) {
      return { label: 'Command', value: String(input.command) }
    }
    if ((permission.toolName === 'Write' || permission.toolName === 'Edit') && input.file_path) {
      return { label: 'File', value: String(input.file_path) }
    }
    if (permission.toolName === 'WebFetch' && input.url) {
      return { label: 'URL', value: String(input.url) }
    }
    if (permission.toolName === 'Grep' && input.pattern) {
      return { label: 'Pattern', value: String(input.pattern) }
    }
    return null
  }

  const inputDetails = getInputDetails()

  console.log(`🔍 [modal] rendering PermissionModal: diff=${permission.diff ? `✅ ${permission.diff.length} chars` : '❌ NONE'}`)

  // Parse diff to extract line numbers from @@ headers
  const parseDiffLines = (diff: string) => {
    const lines = diff.split('\n')
    let oldLine = 0
    let newLine = 0
    return lines.map((line) => {
      const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1])
        newLine = parseInt(hunkMatch[2])
        return { line, type: 'hunk' as const, num: '' }
      }
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:') || line.startsWith('===')) {
        return { line, type: 'meta' as const, num: '' }
      }
      if (line.startsWith('+')) {
        const n = newLine++
        return { line, type: 'add' as const, num: String(n) }
      }
      if (line.startsWith('-')) {
        const n = oldLine++
        return { line, type: 'del' as const, num: String(n) }
      }
      oldLine++
      newLine++
      return { line, type: 'ctx' as const, num: String(newLine - 1) }
    })
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-start justify-center z-50 sm:p-4 sm:pt-8">
      <div className="bg-gray-900 sm:rounded-2xl p-4 sm:p-6 max-w-2xl w-full border-t sm:border border-gray-700/50 shadow-2xl max-h-[85vh] sm:max-h-[90vh] flex flex-col rounded-t-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4 shrink-0">
          <div className="w-9 h-9 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-white">Permission Required</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-300 text-xs font-mono rounded">
                {permission.toolName}
              </span>
              <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded border ${riskColors[riskLevel]}`}>
                {riskLevel.toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-3 mb-4">
          {/* Description */}
          <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-700/50">
            <p className="text-gray-300 text-sm leading-relaxed">{permission.description}</p>
            {inputDetails && !permission.description.includes(inputDetails.value) && (
              <div className="mt-2 pt-2 border-t border-gray-700/50">
                <span className="text-[10px] text-gray-500 uppercase tracking-wider">{inputDetails.label}</span>
                <code className="block mt-1 text-xs text-amber-300 bg-gray-900 p-2 rounded-lg overflow-x-auto whitespace-nowrap">
                  {inputDetails.value}
                </code>
              </div>
            )}
          </div>

          {/* Diff viewer with line numbers */}
          {permission.diff && (() => {
            const parsed = parseDiffLines(permission.diff!)
            const COLLAPSED = 12
            const hasMore = parsed.length > COLLAPSED
            const visible = showFullDiff ? parsed : parsed.slice(0, COLLAPSED)
            const lineColors = {
              meta: 'text-gray-500',
              hunk: 'text-cyan-400 bg-cyan-950/30',
              add: 'text-green-400 bg-green-950/40',
              del: 'text-red-400 bg-red-950/40',
              ctx: 'text-gray-400',
            }
            return (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Changes</span>
                  <span className="text-[10px] text-gray-600">{parsed.filter(p => p.type === 'add').length} additions, {parsed.filter(p => p.type === 'del').length} deletions</span>
                </div>
                <div className={`rounded-xl border border-gray-700/50 bg-gray-950 font-mono text-[11px] sm:text-xs overflow-x-auto ${showFullDiff ? 'max-h-80 overflow-y-auto' : ''}`}>
                  <div className="min-w-max">
                  {visible.map((p, i) => (
                    <div key={i} className={`flex ${lineColors[p.type]} border-b border-gray-800/30 last:border-0`}>
                      {/* Line number gutter */}
                      <span className="w-10 sm:w-12 shrink-0 text-right pr-2 py-px text-gray-600 select-none border-r border-gray-800/50 bg-gray-900/50 sticky left-0">
                        {p.num}
                      </span>
                      {/* Code content */}
                      <span className="px-2 sm:px-3 py-px whitespace-pre">{p.line}</span>
                    </div>
                  ))}
                  </div>
                </div>
                {hasMore && (
                  <button
                    onClick={() => setShowFullDiff(v => !v)}
                    className="mt-2 w-full py-1.5 text-xs text-gray-400 hover:text-gray-200 bg-gray-800/50 hover:bg-gray-800 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className={`w-3 h-3 transition-transform ${showFullDiff ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                    {showFullDiff ? 'Collapse' : `Show ${parsed.length - COLLAPSED} more lines`}
                  </button>
                )}
              </div>
            )
          })()}
        </div>

        {/* Action buttons — sticky at bottom */}
        <div className="shrink-0 space-y-3">
          <div className="flex gap-2">
            <button onClick={() => onRespond('deny')}
              className="flex-1 min-h-11 px-3 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors text-gray-300 text-sm font-medium border border-gray-700">
              Deny
            </button>
            <button onClick={() => onRespond('allow')}
              className="flex-1 min-h-11 px-3 py-2.5 bg-green-600 hover:bg-green-500 rounded-xl transition-colors text-white text-sm font-medium shadow-lg shadow-green-500/20">
              Allow
            </button>
            <button onClick={() => onRespond('always_allow')}
              className="flex-1 min-h-11 px-3 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 rounded-xl transition-all text-white text-sm font-medium shadow-lg shadow-amber-500/20">
              Always
            </button>
          </div>
          <p className="text-gray-600 text-[10px] text-center">
            Or say "allow", "deny", or "always allow"
          </p>
        </div>
      </div>
    </div>
  )
}
