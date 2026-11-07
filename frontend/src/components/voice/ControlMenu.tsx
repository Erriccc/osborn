'use client'

import { useState } from 'react'
import { formatTime, deriveSessionTitle } from '@/lib/sessions'
import { usePanelExclusive, useViewportClamp, type SessionInfo, type McpServerStatus } from './shared'
import { SkillsPanel } from './SkillsPanel'

// Unified Control Menu - Combines mode toggle, session history, tools, and settings
export function ControlMenu({
  sessions,
  currentSessionId,
  onLoadSessions,
  onResumeSession,
  onContinueSession,
  isLoadingSessions,
  disabled,
  mcpServers,
  onMcpToggle,
  onLoadMcpStatus,
  skills,
  onAddSkill,
  onViewSkill,
  onRemoveSkill,
  onInstallFromCatalog,
  skillRemoveArm,
  setSkillRemoveArm,
  showAddSkill,
  setShowAddSkill,
  newSkillName,
  setNewSkillName,
  newSkillContent,
  setNewSkillContent,
}: {
  sessions: SessionInfo[]
  currentSessionId?: string | null
  onLoadSessions: () => void
  onResumeSession: (sessionId: string) => void
  onContinueSession: () => void
  isLoadingSessions?: boolean
  disabled?: boolean
  mcpServers?: McpServerStatus[]
  onMcpToggle?: (serverKey: string, enabled: boolean) => void
  onLoadMcpStatus?: () => void
  skills?: { name: string; description: string; folder?: string }[]
  onAddSkill?: (name: string, content: string) => void
  onViewSkill?: (folder: string) => void
  onRemoveSkill?: (folder: string) => void
  onInstallFromCatalog?: (name: string, url: string) => void
  skillRemoveArm?: string | null
  setSkillRemoveArm?: (v: string | null) => void
  showAddSkill?: boolean
  setShowAddSkill?: (show: boolean) => void
  newSkillName?: string
  setNewSkillName?: (name: string) => void
  newSkillContent?: string
  setNewSkillContent?: (content: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'history' | 'tools'>('history')
  const [showSwitchConfirm, setShowSwitchConfirm] = useState(false)
  const [pendingSwitchSessionId, setPendingSwitchSessionId] = useState<string | null>(null)
  usePanelExclusive('history', isOpen, setIsOpen)
  const menuRef = useViewportClamp(isOpen)

  const enabledMcpCount = (mcpServers || []).filter(s => s.enabled).length
  const skillCount = (skills || []).length
  const toolsBadgeCount = enabledMcpCount + skillCount

  // Load data when tabs are opened
  const handleTabChange = (tab: 'history' | 'tools') => {
    setActiveTab(tab)
    if (tab === 'history' && sessions.length === 0) {
      onLoadSessions()
    }
    if (tab === 'tools') {
      onLoadMcpStatus?.()
    }
  }

  return (
    <div className="relative flex items-center gap-2">
      {/* Session menu — history + tools. (Was mislabeled "Research".) */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all text-xs ${isOpen ? 'bg-gray-800/60 text-gray-200' : 'text-gray-400 hover:bg-gray-800/60 hover:text-gray-200'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        title="Session history & tools"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        <span className="font-medium">History</span>
        <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div ref={menuRef} className="absolute top-10 left-0 w-72 max-w-[calc(100vw-1.5rem)] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-[100] overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-gray-700">
            <button
              onClick={() => handleTabChange('history')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === 'history'
                  ? 'text-amber-400 border-b-2 border-amber-400 bg-amber-500/10'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              History
            </button>
            <button
              onClick={() => handleTabChange('tools')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors relative ${
                activeTab === 'tools'
                  ? 'text-amber-400 border-b-2 border-amber-400 bg-amber-500/10'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Tools
              {toolsBadgeCount > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-green-500/20 text-green-400">
                  {toolsBadgeCount}
                </span>
              )}
            </button>
          </div>

          {/* History Tab */}
          {activeTab === 'history' && (
            <div className="max-h-96 overflow-y-auto">
              <div className="p-2 border-b border-gray-800">
                <button
                  onClick={() => {
                    onContinueSession()
                    setIsOpen(false)
                  }}
                  className="w-full py-2 text-xs bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 transition-colors"
                >
                  Continue Last Session
                </button>
              </div>
              <div className="p-2">
                {isLoadingSessions ? (
                  <div className="flex items-center justify-center py-4 text-gray-500 text-xs">
                    <svg className="w-4 h-4 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Loading...
                  </div>
                ) : sessions.length === 0 ? (
                  <p className="text-center py-4 text-gray-500 text-xs">No previous sessions</p>
                ) : (
                  <div className="space-y-1">
                    {sessions.map((session) => (
                      <button
                        key={session.sessionId}
                        onClick={() => {
                          if (currentSessionId && currentSessionId !== session.sessionId) {
                            // Show confirmation for mid-conversation switch
                            setPendingSwitchSessionId(session.sessionId)
                            setShowSwitchConfirm(true)
                          } else {
                            onResumeSession(session.sessionId)
                            setIsOpen(false)
                          }
                        }}
                        className={`w-full text-left p-2 rounded-lg transition-colors text-xs ${
                          currentSessionId === session.sessionId
                            ? 'bg-amber-500/20 border border-amber-500/30'
                            : 'hover:bg-gray-800'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-gray-400">{formatTime(session.timestamp)}</span>
                          <span className="text-gray-500">{session.messageCount} msgs</span>
                        </div>
                        <p className="text-gray-300 truncate">
                          {deriveSessionTitle(session.lastMessage)}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tools Tab */}
          {activeTab === 'tools' && (
            <div className="max-h-96 overflow-y-auto p-3 space-y-3">
              {/* Skills Section — shared SkillsPanel (also mounted in the header SkillsPopover) */}
              <SkillsPanel
                skills={skills}
                onAddSkill={onAddSkill}
                onViewSkill={onViewSkill}
                onRemoveSkill={onRemoveSkill}
                onInstallFromCatalog={onInstallFromCatalog}
                skillRemoveArm={skillRemoveArm}
                setSkillRemoveArm={setSkillRemoveArm}
                showAddSkill={showAddSkill}
                setShowAddSkill={setShowAddSkill}
                newSkillName={newSkillName}
                setNewSkillName={setNewSkillName}
                newSkillContent={newSkillContent}
                setNewSkillContent={setNewSkillContent}
              />

              {/* MCP Servers Section */}
              {(!mcpServers || mcpServers.length === 0) ? (
                <p className="text-center py-4 text-gray-500 text-xs">No MCP tools available</p>
              ) : (
                <>
                  {/* Group by category */}
                  {(['code', 'web', 'data', 'utility'] as const).map(category => {
                    const serversInCategory = mcpServers.filter(s => s.category === category)
                    if (serversInCategory.length === 0) return null
                    const categoryLabels: Record<string, string> = {
                      code: 'Code', web: 'Web', data: 'Data', utility: 'Utility',
                    }
                    return (
                      <div key={category}>
                        <h4 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                          {categoryLabels[category]}
                        </h4>
                        <div className="space-y-1">
                          {serversInCategory.map(server => (
                            <div
                              key={server.serverKey}
                              className="flex items-center justify-between p-2 rounded-lg bg-gray-800/50 border border-gray-700/30"
                            >
                              <div className="flex-1 min-w-0 mr-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-medium text-gray-200">{server.name}</span>
                                  {server.source === 'config' && (
                                    <span className="text-[9px] px-1 py-0.5 rounded bg-gray-700 text-gray-400">custom</span>
                                  )}
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                                    server.transport === 'stdio' ? 'bg-gray-700 text-gray-400' : 'bg-emerald-900/50 text-emerald-400'
                                  }`}>
                                    {server.transport === 'stdio' ? 'local' : 'cloud'}
                                  </span>
                                </div>
                                <p className="text-[11px] text-gray-500 truncate">{server.description}</p>
                                {!server.available && server.missingEnvVars && (
                                  <p className="text-[10px] text-amber-400 mt-0.5">
                                    Missing: {server.missingEnvVars.join(', ')}
                                  </p>
                                )}
                              </div>
                              <button
                                onClick={() => onMcpToggle?.(server.serverKey, !server.enabled)}
                                disabled={!server.available}
                                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                                  !server.available
                                    ? 'bg-gray-700 cursor-not-allowed opacity-50'
                                    : server.enabled
                                    ? 'bg-green-500'
                                    : 'bg-gray-600 hover:bg-gray-500'
                                }`}
                                title={!server.available ? `Missing env vars: ${server.missingEnvVars?.join(', ')}` : server.enabled ? 'Disable' : 'Enable'}
                              >
                                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                                  server.enabled ? 'translate-x-4' : 'translate-x-0'
                                }`} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  <p className="text-[10px] text-gray-600 text-center pt-1">
                    Changes apply on next message
                  </p>
                </>
              )}
            </div>
          )}

          {/* Switch confirmation dialog */}
          {showSwitchConfirm && (
            <div className="absolute inset-0 bg-black/80 flex items-center justify-center rounded-lg z-10">
              <div className="bg-gray-800 p-4 rounded-lg text-center">
                <p className="text-sm text-white mb-3">Switch to this session?</p>
                <p className="text-xs text-gray-400 mb-4">Current context will be saved.</p>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={() => setShowSwitchConfirm(false)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (pendingSwitchSessionId) {
                        onResumeSession(pendingSwitchSessionId)
                      }
                      setShowSwitchConfirm(false)
                      setIsOpen(false)
                    }}
                    className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 rounded text-sm"
                  >
                    Switch
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
