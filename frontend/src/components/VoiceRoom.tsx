'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo, useReducer } from 'react'
import {
  useVoiceAssistant,
  useDataChannel,
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react'
import { RoomEvent, ConnectionState, Track } from 'livekit-client'
import '@livekit/components-styles'
import { MarkdownMessage } from './MarkdownMessage'
import LiveClock from './LiveClock'
import { LogsDrawer, type MachineData } from './LogsDrawer'
import { FilesExplorerModal } from './FilesExplorerModal'
import { uploadFile, isSupabaseConfigured, type UploadResult } from '../lib/supabase'
import { createSupabaseBrowser } from '../lib/supabase-browser'
import { formatTime, groupSessionsByDate, deriveSessionTitle } from '@/lib/sessions'
import { useChatSession } from './ChatSessionProvider'
import { useSearchParams } from 'next/navigation'
import { usePanelExclusive, useViewportClamp, addTimeTag, formatElapsed, sanitizeUserTranscript, type ToolMeta, type ChatMessage, type SpeakingChunk, type SessionInfo, type SlotInfo, type McpServerStatus, type GeneratedFile } from './voice/shared'
import { StatusIndicator, VoiceVisualizer } from './voice/OrbStatus'
import { MicBanner } from './voice/MicBanner'
import { RESUME_CHIP_TIMEOUT_MS, resumeChipLabel, resumeChipReducer } from '@/lib/resume-chip'
import { MIC_DENIED_EVENT, isMicDenied, micErrorKind, noteMicBannerShown, setMicDenied, shouldAutoEnableMic, shouldShowMicBanner, type KV, type MicErrorKind } from '@/lib/mic-permission'
import { InstancesPanel } from './voice/InstancesPanel'
import { PermissionModal, getToolRiskLevel, type PermissionRequest } from './voice/PermissionModal'
import { TextInput, type AttachedFile } from './voice/TextInput'
import { AgentsPopover, type NamedAgent, type UserAgentDraft } from './voice/AgentsPopover'
import { SkillsPopover } from './voice/SkillsPanel'
import { ControlMenu } from './voice/ControlMenu'
import { ChatPanel } from './voice/ChatPanel'
import { RightPanel, PanelToggleButton, PANEL_ANCHOR_ATTR } from './panel/RightPanel'
import { PanelDataProvider, usePanelState, type PanelData } from './panel/PanelDataContext'
import { resolveTabId } from './panel/registry'
import { AUTO_OPEN_OUTPUTS_ON_WRITE, LOAD_ERROR_OUTSIDE, agentCanServe, favoriteSaveOutcome, fileFromToolEvent, isImageName, markUnread, replaceArtifacts, toMs, upsertAgentFile } from '@/lib/outputs-model'

// ── Audio settings panel (Phase C) ───────────────────────────────────────
// The audit (C / P0-2) wanted an in-app audio panel instead of relying on the
// browser's mic dialog; this was the genuinely-missing piece. Mic + speaker
// pickers (live-switched via LiveKit's room.switchActiveDevice) and a speaker
// test tone. Device labels only populate once the user has allowed mic access.
const NOOP_KV: KV = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
/** sessionStorage, or a no-op store where it is unavailable (SSR, blocked). */
function micStore(): KV {
  try { return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : NOOP_KV } catch { return NOOP_KV }
}

function AudioPopover({ disabled }: { disabled?: boolean }) {
  const room = useRoomContext()
  const [open, setOpen] = useState(false)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])
  usePanelExclusive('audio', open, setOpen)
  const popRef = useViewportClamp(open)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    navigator.mediaDevices?.enumerateDevices?.().then((ds) => {
      setMics(ds.filter((d) => d.kind === 'audioinput'))
      setSpeakers(ds.filter((d) => d.kind === 'audiooutput'))
    }).catch(() => { /* enumeration blocked */ })
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const pick = async (kind: 'audioinput' | 'audiooutput', id: string) => {
    try { await room?.switchActiveDevice(kind, id) } catch { /* device unavailable */ }
  }
  const testSpeaker = () => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.frequency.value = 440; gain.gain.value = 0.07
      osc.connect(gain); gain.connect(ctx.destination); osc.start()
      setTimeout(() => { try { osc.stop(); void ctx.close() } catch { /* already closed */ } }, 600)
    } catch { /* no AudioContext */ }
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} disabled={disabled}
        aria-label="Audio settings" title="Audio (mic & speaker)"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all ${
          disabled ? 'text-gray-600 cursor-not-allowed'
            : open ? 'bg-amber-500/20 text-amber-300' : 'text-gray-500 hover:bg-gray-800/60 hover:text-gray-200'
        }`}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
        <span className="hidden sm:inline">Audio</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div ref={popRef} className="fixed inset-x-0 bottom-0 max-h-[78vh] overflow-y-auto sm:overflow-hidden sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-none sm:w-[min(22rem,calc(100vw-1.5rem))] z-50 bg-gray-900 border border-gray-700/60 rounded-t-2xl sm:rounded-xl shadow-2xl pb-[env(safe-area-inset-bottom)] sm:pb-0">
            <div className="px-3 py-2 border-b border-gray-800">
              <span className="text-xs font-semibold text-gray-200">🎧 Audio</span>
            </div>
            <div className="p-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-gray-500">Microphone</span>
                <select defaultValue="" onChange={(e) => pick('audioinput', e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-2 text-[13px] text-gray-200 outline-none focus:border-amber-500/50">
                  <option value="">Default microphone</option>
                  {mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-gray-500">Speaker</span>
                <select defaultValue="" onChange={(e) => pick('audiooutput', e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-2 text-[13px] text-gray-200 outline-none focus:border-amber-500/50">
                  <option value="">Default speaker</option>
                  {speakers.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
                </select>
              </label>
              <button onClick={testSpeaker}
                className="self-start rounded-lg bg-gray-800 border border-gray-700 px-3 py-1.5 text-[12.5px] text-gray-200 hover:border-amber-500/40 transition-colors">
                Test speaker (plays a tone)
              </button>
              <p className="text-[11px] text-gray-500 leading-relaxed">Device names appear once you&rsquo;ve allowed mic access. Picks apply live to this session.</p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Public props for VoiceRoom. All session-level state (token, disconnect
// handler, agent-ready callback, auth callback, preSelectedSessionId,
// provider) now lives in ChatSessionProvider and is read via
// useChatSession() inside the default export below. Only truly
// UI-local flags remain as props.
interface VoiceRoomProps {
  waitingMode?: boolean
}

// Build the prior-conversation block for a resumed session: real timestamps plus
// Slack-style date dividers wherever the calendar day changes. Shared by the HTTP
// hydration path (mount-time fetch) and the data-channel prior_messages fallback —
// both emit `prior-` prefixed ids so whichever lands second is deduped.
function buildPriorItems(
  sessionId: string,
  msgs: Array<{ role: string; content: string; ts?: string | number | null }>,
): ChatMessage[] {
  const items: ChatMessage[] = []
  let lastDay = ''
  msgs.forEach((m, i) => {
    const t = m.ts ? new Date(m.ts) : new Date(0)
    const day = t.getTime() > 0 ? t.toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''
    if (day && day !== lastDay) {
      lastDay = day
      items.push({ id: `prior-day-${day}-${sessionId}`, role: 'system', content: `── ${day} ──`, timestamp: t })
    }
    items.push({
      id: `prior-${i}-${sessionId}`,
      role: (m.role === 'assistant' ? 'assistant' : 'user') as ChatMessage['role'],
      content: m.content,
      timestamp: t,
    })
  })
  if (items.length > 0) {
    items.push({ id: `prior-sep-${sessionId}`, role: 'system', content: '── Today ──', timestamp: new Date() })
  }
  return items
}

// Inner component with LiveKit hooks
function VoiceRoomInner({
  onDisconnect,
  onAgentReady,
  onAuthRequired,
  onVoiceActivity,
  waitingMode,
  preSelectedSessionId,
  agentUrl,
  seedPrompt,
}: {
  onDisconnect?: () => void
  onAgentReady?: () => void
  onAuthRequired?: () => void
  onVoiceActivity?: () => void
  waitingMode?: boolean
  preSelectedSessionId?: string | null
  agentUrl?: string
  seedPrompt?: string | null
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  // Project/workspace context for this session (from the chat URL via the
  // provider) — surfaced as a header chip so a stranger can see WHICH repo /
  // project the session is attached to (audit C1/P1-7; §12 found it invisible,
  // and a project session even opened in an empty placeholder dir).
  const sessionCwd = useSearchParams()?.get('workingDirectory') || ''
  const projectName = (() => {
    if (!sessionCwd) return null
    const segs = sessionCwd.replace(/\/+$/, '').split('/').filter(Boolean)
    const leaf = segs[segs.length - 1] || ''
    return !leaf || leaf.toLowerCase() === 'workspace' ? 'Workspace' : leaf
  })()
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  // iOS recovery surfaces (2026-10-24 mobile branch, P1.6/P1.7). audioBlocked →
  // "tap to enable sound" bar when the room's AudioContext started suspended
  // (connect flow begins without a user gesture; the first TTS would play into
  // silence). micError → recovery overlay when mic capture fails — previously
  // MediaDevicesError was log-only and a denied mic meant an eternal spinner.
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [micError, setMicError] = useState<MicErrorKind | null>(null)
  // Bug 0e5479b6: transient resume status, outside the transcript (never
  // copied or persisted); first assistant message or 30s clears it.
  const [resumeChip, dispatchResumeChip] = useReducer(resumeChipReducer, null)
  useEffect(() => {
    if (!resumeChip) return
    const left = Math.max(0, resumeChip.startedAt + RESUME_CHIP_TIMEOUT_MS - Date.now())
    const id = setTimeout(() => dispatchResumeChip({ type: 'tick', now: Date.now() }), left + 50)
    return () => clearTimeout(id)
  }, [resumeChip])
  // Bug 7cf00ae6: once the browser denied the mic, nothing re-requests it on
  // its own (agent 'listening', session gate, LiveKit reconnect) — only the
  // user's explicit Try again / unmute. Flag lives in sessionStorage so the
  // provider's LiveKitRoom also stops publishing the mic on reconnect.
  const micDeniedRef = useRef(false)
  const micUserRetryRef = useRef(false)
  const micBannerShownRef = useRef(new Set<MicErrorKind>())
  useEffect(() => { micDeniedRef.current = isMicDenied(micStore()) }, [])
  const markMicDenied = useCallback((denied: boolean) => {
    if (micDeniedRef.current === denied) return
    micDeniedRef.current = denied
    setMicDenied(micStore(), denied)
    try { window.dispatchEvent(new Event(MIC_DENIED_EVENT)) } catch { /* SSR */ }
  }, [])
  // YOLO toggle: when enabled, the frontend intercepts every incoming
  // permission_request and sends back an immediate allow without showing
  // the modal. Persisted to localStorage so it survives reloads. Default
  // OFF. Applied at the data-channel handler in handleDataMessage (see the
  // permission_request branch below) — the agent still emits requests, we
  // just auto-respond.
  const [autoApprovePermissions, setAutoApprovePermissions] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('osborn-auto-approve-permissions') === 'true'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem('osborn-auto-approve-permissions', String(autoApprovePermissions))
  }, [autoApprovePermissions])
  // Mirror the toggle into a ref so the data-channel handler can read the
  // latest value without listing autoApprovePermissions in its dependency
  // array (which would re-subscribe the room on every toggle flip and
  // momentarily drop incoming messages).
  const autoApprovePermissionsRef = useRef(autoApprovePermissions)
  useEffect(() => { autoApprovePermissionsRef.current = autoApprovePermissions }, [autoApprovePermissions])
  const [claudeAuthUrl, setClaudeAuthUrl] = useState<string | null>(null)
  const [claudeAuthStatus, setClaudeAuthStatus] = useState<'none' | 'required' | 'waiting' | 'waiting_code' | 'submitting' | 'complete' | 'error'>('none')
  const [claudeAuthCode, setClaudeAuthCode] = useState('')
  const [agentConnected, setAgentConnected] = useState(false)
  // Multi-instance slots panel
  const [slots, setSlots] = useState<SlotInfo[]>([])
  const [spawnPending, setSpawnPending] = useState(false)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const [showInstancesPanel, setShowInstancesPanel] = useState(false)
  const [showHeaderMore, setShowHeaderMore] = useState(false) // desktop header overflow — consolidates the loose icon row into one labeled "More"
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [agentState, setAgentState] = useState<string>('idle')
  const [speakingChunk, setSpeakingChunk] = useState<SpeakingChunk | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  // Honesty guard: true only after the mic has been confirmed OFF (not merely
  // muted) for a grace period while the agent says it's listening — so the orb
  // never claims "Listening" when input is actually impossible (permission
  // denied / no device), without flickering during the normal connect gap.
  const [micConfirmedOff, setMicConfirmedOff] = useState(false)
  // Noise-cancellation (noise gate): agent-side transcript triage. State is
  // authoritative from the agent (noise_cancel_state) — meeting mode can
  // auto-engage it without a click here.
  const [noiseCancelOn, setNoiseCancelOn] = useState(false)
  const [gateDropped, setGateDropped] = useState<Array<{ text: string; verdict: string; ts: number }>>([])
  // Session management state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  // Auto-resume prompt state
  const [showResumePrompt, setShowResumePrompt] = useState(false)
  const [recentSessionId, setRecentSessionId] = useState<string | null>(null)
  // Session gate: tracks whether user has chosen a session (or fresh start) before voice begins
  const [sessionGateCompleted, setSessionGateCompleted] = useState(false)
  // Copy feedback state for "Copy All Messages" button
  const [copyFeedback, setCopyFeedback] = useState(false)
  // Generated files state (plans + research artifacts)
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[]>([])
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)

  // Favorited session files — a durable, user-pinned subset. Everything else in
  // the explorer can churn (session switch clears it, artifacts get pruned), but
  // favorites are persisted to localStorage WITH their metadata + Supabase URL,
  // so they survive reloads and are re-injected into the list on mount. This is
  // the "favorited files stay up even if everything else gets lost" behavior.
  const FAVORITES_KEY = 'osborn-favorite-files'
  const [favoriteFiles, setFavoriteFiles] = useState<GeneratedFile[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const raw = localStorage.getItem(FAVORITES_KEY)
      if (!raw) return []
      const arr = JSON.parse(raw) as GeneratedFile[]
      return arr.map((f) => ({ ...f, updatedAt: new Date(f.updatedAt) }))
    } catch { return [] }
  })
  // Fast membership check keyed by filePath (stable per file).
  const favoritePaths = useMemo(() => new Set(favoriteFiles.map((f) => f.filePath)), [favoriteFiles])
  // Ref mirror so the async toggle can check membership without stale closures.
  const favoriteFilesRef = useRef(favoriteFiles)
  useEffect(() => { favoriteFilesRef.current = favoriteFiles }, [favoriteFiles])

  // Persist favorites to localStorage (per-device cache) AND the server (source
  // of truth, cross-device). Slim: metadata + durable URL only, never base64.
  // sessionId scopes the server-side blob so different sessions never leak into
  // each other; when sessionId is not yet known the POST is skipped (the caller
  // will retry once the agent reports the session).
  // Returns the HTTP status of the server write (null on network failure) so the
  // caller can roll back an optimistic star (UI#21: check res.ok, not only throws).
  const persistFavorites = useCallback(async (next: GeneratedFile[]): Promise<number | null> => {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)) } catch { /* quota — ignore */ }
    try {
      const res = await fetch('/api/favorites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorites: next }),
      })
      return res.status
    } catch { return null }
  }, [])
  const setFavoritesNow = useCallback((next: GeneratedFile[]) => {
    favoriteFilesRef.current = next
    setFavoriteFiles(next)
  }, [])
  const [pinError, setPinError] = useState<string | null>(null)
  const lastPinFailRef = useRef<GeneratedFile | null>(null)

  // Optimistic pin/unpin (UI#21): the star flips in the click, the server write
  // runs in the background, and a failed write rolls back with a retryable
  // notice. 401 = guest, whose favorites are device-local by design.
  // Never sends anything to the agent (no `[favorited]` user_text).
  const toggleFavorite = useCallback(async (file: GeneratedFile) => {
    const before = favoriteFilesRef.current
    const prevEntry = before.find((f) => f.filePath === file.filePath)
    const currentlyFav = !!prevEntry
    const slim: GeneratedFile = {
      filePath: file.filePath, fileName: file.fileName, url: file.url,
      type: file.type, source: file.source, updatedAt: file.updatedAt,
      isImage: file.isImage, mimeType: file.mimeType,
    }
    setPinError(null)
    setFavoritesNow(currentlyFav ? before.filter((f) => f.filePath !== file.filePath) : [...before, slim])
    if (!currentlyFav) {
      setGeneratedFiles((prev) => prev.some((f) => f.filePath === file.filePath) ? prev : [{ ...file }, ...prev])
    }
    const outcome = favoriteSaveOutcome(await persistFavorites(favoriteFilesRef.current))
    if (outcome === 'rollback') {
      const cur = favoriteFilesRef.current
      const rolled = currentlyFav
        ? (cur.some((f) => f.filePath === file.filePath) ? cur : [...cur, prevEntry!])
        : cur.filter((f) => f.filePath !== file.filePath)
      setFavoritesNow(rolled)
      try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(rolled)) } catch { /* ignore */ }
      lastPinFailRef.current = file
      setPinError(currentlyFav ? `Couldn't unpin ${file.fileName}.` : `Couldn't save pin for ${file.fileName}.`)
      return
    }
    // Durable copy, in the background, so the pin opens on any device. Only
    // when we hold the FULL text: never upload a truncated preview or an image
    // placeholder as the permanent copy.
    if (!currentlyFav && !file.url && typeof file.content === 'string' && file.content.length > 0
      && !file.isImage && !isImageName(file.fileName) && !file.truncated) {
      try {
        const fd = new FormData()
        fd.append('file', new Blob([file.content], { type: 'text/plain' }), file.fileName)
        fd.append('folder', 'favorites')
        const res = await fetch('/api/upload', { method: 'POST', body: fd })
        const j = res.ok ? await res.json().catch(() => null) : null
        const url: string | undefined = j?.url
        if (url && favoriteFilesRef.current.some((f) => f.filePath === file.filePath)) {
          const withUrl = favoriteFilesRef.current.map((f) => (f.filePath === file.filePath ? { ...f, url } : f))
          setFavoritesNow(withUrl)
          void persistFavorites(withUrl)
          setGeneratedFiles((prev) => prev.map((f) => (f.filePath === file.filePath ? { ...f, url: f.url || url } : f)))
        }
      } catch { /* best effort — the pin is saved, just without a durable copy */ }
    }
  }, [persistFavorites, setFavoritesNow])
  const retryPin = useCallback(() => {
    const f = lastPinFailRef.current
    lastPinFailRef.current = null
    if (f) void toggleFavorite(f)
  }, [toggleFavorite])

  // Surface favorites in the explorer whenever the set changes (initial load,
  // server sync, or a toggle) — so a returning user always sees their pinned
  // files even before the agent/Supabase reports this session's files.
  useEffect(() => {
    if (favoriteFiles.length === 0) return
    setGeneratedFiles((prev) => {
      const have = new Set(prev.map((f) => f.filePath))
      const missing = favoriteFiles.filter((f) => !have.has(f.filePath))
      return missing.length ? [...missing, ...prev] : prev
    })
  }, [favoriteFiles])

  // Cross-device favorites — SERVER IS AUTHORITATIVE. User-level (not session-level)
  // so favorites persist across sessions. Runs once per session to sync.
  //  - if the server has a record → replace local with it (cross-device propagation)
  //  - if no server record yet → seed from localStorage so first sync preserves existing stars.
  const syncedSessionRef = useRef<string | null>(null)
  useEffect(() => {
    // Wait until we know which session we're in; also guard against running
    // twice for the same session if currentSessionId identity changes.
    if (!currentSessionId) return
    if (syncedSessionRef.current === currentSessionId) return
    syncedSessionRef.current = currentSessionId

    let cancelled = false
    fetch(`/api/favorites`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json) return

        // Read whatever is currently in localStorage — may include items that
        // were starred but whose POST failed in a previous session.
        let local: GeneratedFile[] = []
        try {
          const raw = localStorage.getItem(FAVORITES_KEY)
          if (raw) local = (JSON.parse(raw) as GeneratedFile[]).map((f) => ({ ...f, updatedAt: new Date(f.updatedAt) }))
        } catch { /* ignore */ }

        if (json.exists && Array.isArray(json.favorites)) {
          const server = (json.favorites as GeneratedFile[]).map((f) => ({ ...f, updatedAt: new Date(f.updatedAt) }))
          // Merge: server is authoritative, but also keep any localStorage items
          // not yet on the server (guards against a failed POST in a prior session).
          const serverPaths = new Set(server.map((f) => f.filePath))
          const localOnly = local.filter((f) => f.filePath && !serverPaths.has(f.filePath))
          const merged = localOnly.length > 0 ? [...server, ...localOnly] : server
          setFavoriteFiles(merged)
          try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(merged)) } catch { /* ignore */ }
          // Back-fill server if we found local-only items (they missed a POST).
          if (localOnly.length > 0) {
            fetch('/api/favorites', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ favorites: merged }),
            }).catch(() => {})
          }
        } else if (local.length > 0) {
          // No server record yet — seed from localStorage (first-time / migration).
          fetch('/api/favorites', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: local }),
          }).catch(() => {})
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [currentSessionId])
  const [fileCopyFeedback, setFileCopyFeedback] = useState<string | null>(null)
  // Full-screen Files view: reachable only through "Expand" in the Outputs drawer.
  const [isFilesModalOpen, setIsFilesModalOpen] = useState(false)
  // Right-side living panel (L4): open/tab/width persisted in localStorage `vn-panel`.
  const panel = usePanelState()
  const outputsVisible = panel.open && resolveTabId(panel.tab) === 'outputs'
  const outputsVisibleRef = useRef(outputsVisible)
  useEffect(() => { outputsVisibleRef.current = outputsVisible }, [outputsVisible])
  const [outputsPreviewPath, setOutputsPreviewPath] = useState<string | null>(null)
  // MCP server state
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])
  // Skills state
  const [skills, setSkills] = useState<{ name: string; description: string; folder?: string }[]>([])
  const [namedAgents, setNamedAgents] = useState<NamedAgent[]>([])
  const [viewedSkill, setViewedSkill] = useState<{ name: string; content: string } | null>(null)
  // Esc closes the skill viewer (× and backdrop-click already close it).
  useEffect(() => {
    if (!viewedSkill) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewedSkill(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewedSkill])
  const [skillRemoveArm, setSkillRemoveArm] = useState<string | null>(null)
  const [showAddSkill, setShowAddSkill] = useState(false)
  const [showMobileMenu, setShowMobileMenu] = useState(false)
  // Burger-sheet → popover bridges: incrementing these force-opens the
  // header-less (hideTrigger) Agents/Skills panels rendered at top level,
  // after the sheet has closed.
  const [agentsOpenReq, setAgentsOpenReq] = useState(0)
  const [skillsOpenReq, setSkillsOpenReq] = useState(0)
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillContent, setNewSkillContent] = useState('')
  // Research tracking state
  const [activeResearch, setActiveResearch] = useState<{ taskId: string; task: string; toolCount: number } | null>(null)
  // Background flows dispatched by the orchestrator (agent_started / task_completed)
  const [backgroundFlows, setBackgroundFlows] = useState<Array<{
    agentId: string
    agentType: string
    status: string
    artifact?: string
    task?: string        // the instruction the sub-agent was dispatched with (shown while running)
    lastMessage?: string // latest live activity while running (from the sub-agent's tool stream)
    startedAt?: number   // client ts when the row was created — grace window for reconcile
  }>>([])
  // Meeting state (Recall.ai)
  const [showMeetingInput, setShowMeetingInput] = useState(false)
  // Keep the header dropdowns mutually exclusive (no stacking/overlap).
  usePanelExclusive('instances', showInstancesPanel, setShowInstancesPanel)
  usePanelExclusive('more', showHeaderMore, setShowHeaderMore)
  usePanelExclusive('meeting', showMeetingInput, setShowMeetingInput)
  // Keep the More menu / meeting popover on screen when the header wraps and
  // their right-anchored triggers land on the left (iPad portrait).
  const moreMenuRef = useViewportClamp(showHeaderMore)
  const meetingPopRef = useViewportClamp(showMeetingInput)
  const [meetingUrlInput, setMeetingUrlInput] = useState('')
  const [meetingBotId, setMeetingBotId] = useState<string | null>(null)
  const [meetingStatus, setMeetingStatus] = useState<'idle' | 'joining' | 'joined' | 'error'>('idle')
  // MEETING = ACTIVITY (2026-08-01): the provider's 15-min voice-idle check was
  // STOPPING the Fly machine mid-meeting (exit 130, "STT stopped after a
  // while") — nobody touches the voice tab while talking in the Meet. While a
  // meeting is joined, heartbeat the activity marker so idle-stop never fires.
  useEffect(() => {
    if (meetingStatus !== 'joined') return
    onVoiceActivity?.()
    const t = setInterval(() => onVoiceActivity?.(), 60_000)
    return () => clearInterval(t)
  }, [meetingStatus, onVoiceActivity])
  // Poll agent /health every 15s for machine memory stats.
  // Defensive: silently no-ops if agentUrl is absent, network fails, or the
  // agent is an older build that doesn't include the `memory` field yet.
  useEffect(() => {
    if (!agentUrl) return
    const base = agentUrl.replace(/\/$/, '')
    let cancelled = false
    const poll = async () => {
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
        if (!cancelled && r.ok) {
          const d = await r.json()
          if (!cancelled && d?.memory && typeof d.memory.usedPct === 'number') {
            setAgentMemory(d.memory)
          }
        }
      } catch { /* network error / timeout — keep previous reading */ }
    }
    poll()
    const id = setInterval(poll, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [agentUrl])
  // PRIOR-CONVERSATION HYDRATION — fetch the resumed session's recent messages
  // over plain HTTP at MOUNT, in parallel with the LiveKit connect, so the
  // transcript paints immediately instead of after the voice handshake. The
  // agent's data-channel prior_messages push stays as the fallback for older
  // agent builds; the `prior-` id guard dedupes whichever lands second.
  useEffect(() => {
    if (!agentUrl || !preSelectedSessionId) return
    const base = agentUrl.replace(/\/$/, '')
    let cancelled = false
    ;(async () => {
      // A reloaded/resumed session often hits a COLD machine (idle-stopped), so
      // the first fetch can time out or return empty before the agent is up —
      // leaving only a fresh greeting in the pane (audit §16.4 reload quirk).
      // Retry with backoff until the prior messages actually paint.
      const delays = [0, 2000, 4000, 7000, 12000]
      for (const wait of delays) {
        if (cancelled) return
        if (wait) await new Promise(res => setTimeout(res, wait))
        if (cancelled) return
        try {
          const r = await fetch(
            `${base}/session-messages?session=${encodeURIComponent(preSelectedSessionId)}&limit=50`,
            { signal: AbortSignal.timeout(8000) },
          )
          if (cancelled || !r.ok) continue
          const d = await r.json()
          if (cancelled) return
          if (!Array.isArray(d?.messages) || d.messages.length === 0) continue
          console.log(`💬 prior messages hydrated over HTTP: ${d.messages.length}`)
          const priorItems = buildPriorItems(preSelectedSessionId, d.messages)
          setMessages(prev => (prev.some(m => m.id.startsWith('prior-')) ? prev : [...priorItems, ...prev]))
          return // painted — stop retrying
        } catch { /* cold machine / network — retry */ }
      }
    })()
    return () => { cancelled = true }
  }, [agentUrl, preSelectedSessionId])
  const [meetingError, setMeetingError] = useState<string | null>(null)
  // IDE (code-server) state
  const [ideStatus, setIdeStatus] = useState<'idle' | 'starting' | 'ready' | 'error'>('idle')
  const [ideError, setIdeError] = useState<string | null>(null)
  const [ideUrl, setIdeUrl] = useState<string | null>(null)
  // Meeting TODOs panel — fed by the agent writing meeting-todos.md in the
  // workspace. `research_artifact_updated` already fires automatically when
  // any file under /osb/ is written, and `get_research_artifact` returns the
  // content. We just slice the `notes` file matching name `meeting-todos.md`.
  const [meetingTodosContent, setMeetingTodosContent] = useState<string | null>(null)
  const [meetingTodosUpdatedAt, setMeetingTodosUpdatedAt] = useState<number | null>(null)
  // Compaction status indicator — full lifecycle visualization
  // Compaction is a ~1-3 minute server-side process. Earlier UX used a tiny pill
  // that animated only for the brief moment between started/complete; users
  // missed it entirely. New UX: keep a prominent panel visible for the entire
  // window, with a rolling list of stages so the user sees real progress.
  const [compactionStatus, setCompactionStatus] = useState<'idle' | 'compacting' | 'complete'>('idle')
  // Background dispatch (Pattern #2 P1 — tag & continue) notice banner. Set when
  // the agent acks a dispatch (background_dispatched) or reports a result
  // (background_update). Cleared on dismiss or auto after the "done" toast window.
  const [bgNotice, setBgNotice] = useState<{ kind: 'dispatched' | 'done'; sessionId: string; text: string } | null>(null)
  const [compactionStages, setCompactionStages] = useState<Array<{ stage: string; detail?: string; ts: number }>>([])
  const [compactionSkills, setCompactionSkills] = useState<string[]>([])
  const [compactionStartedAt, setCompactionStartedAt] = useState<number | null>(null)
  // Machine memory — polled from agent /health every 15s.
  // Shape: { totalMb, usedMb, availableMb, usedPct, processRssMb } (all integers).
  // May be undefined when the agent hasn't published the field yet — render nothing.
  const [agentMemory, setAgentMemory] = useState<{ totalMb: number; usedMb: number; availableMb: number; usedPct: number; processRssMb: number } | undefined>(undefined)
  // Machine tab: process list data received via data channel (list_processes / process_list).
  const [machineData, setMachineData] = useState<MachineData | undefined>(undefined)
  // Whether the Machine tab is currently active in the drawer — drives polling.
  const [machineTabActive, setMachineTabActive] = useState(false)

  // Derived: currently selected file for preview
  const selectedFile = useMemo(() => {
    return generatedFiles.find(f => f.filePath === selectedFilePath) || generatedFiles[0] || null
  }, [generatedFiles, selectedFilePath])

  // Hydrate content for a URL-backed file the user opens (Supabase-listed files
  // arrive with a `url` but no inline content). Text/markdown/html are fetched
  // and rendered inline; images render straight from the URL; binaries (PDFs)
  // fall through to an "Open" link in the viewer. Without this, a bucket file
  // would spin on "Loading content…" forever.
  useEffect(() => {
    const f = selectedFile
    if (!f || !f.url || f.content || f.isImage) return
    const ext = f.fileName.split('.').pop()?.toLowerCase() || ''
    const textLike = ['md', 'markdown', 'txt', 'html', 'htm', 'svg', 'json', 'csv', 'log', 'yaml', 'yml', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'css'].includes(ext)
    if (!textLike) return // binary — viewer shows an open link, no fetch
    let cancelled = false
    fetch(f.url)
      .then((r) => (r.ok ? r.text() : null))
      .then((text) => {
        if (cancelled || text == null) return
        setGeneratedFiles((prev) => prev.map((x) => (x.filePath === f.filePath ? { ...x, content: text } : x)))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedFile])

  const { localParticipant, isMicrophoneEnabled: micEnabled } = useLocalParticipant()

  const toggleMute = useCallback(async () => {
    if (localParticipant) {
      const newMuted = !isMuted
      if (!newMuted) micUserRetryRef.current = true // explicit user unmute
      await localParticipant.setMicrophoneEnabled(!newMuted)
      setIsMuted(newMuted)
    }
  }, [localParticipant, isMuted])

  // Copy all messages to clipboard with timestamps
  const handleCopyAllMessages = useCallback(async () => {
    if (messages.length === 0) return

    const formattedText = messages
      .map(msg => {
        const role = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Osborn' : 'System'
        const time = msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        return `[${time}] ${role}:\n${msg.content}`
      })
      .join('\n\n---\n\n')

    try {
      await navigator.clipboard.writeText(formattedText)
      setCopyFeedback(true)
      setTimeout(() => setCopyFeedback(false), 1500)
    } catch (err) {
      console.error('Failed to copy messages:', err)
    }
  }, [messages])

  // Copy single generated file
  const handleCopyFile = useCallback(async (filePath: string) => {
    const file = generatedFiles.find(f => f.filePath === filePath)
    if (!file?.content) return
    try {
      await navigator.clipboard.writeText(file.content)
      setFileCopyFeedback(filePath)
      setTimeout(() => setFileCopyFeedback(null), 1500)
    } catch (err) {
      console.error('Failed to copy file:', err)
    }
  }, [generatedFiles])

  // Copy all generated files
  const handleCopyAllFiles = useCallback(async () => {
    const allContent = generatedFiles
      .filter(f => f.content && !f.isImage)
      .map(f => `# ${f.fileName}\n\n${f.content}`)
      .join('\n\n---\n\n')
    if (!allContent) return
    try {
      await navigator.clipboard.writeText(allContent)
      setFileCopyFeedback('all')
      setTimeout(() => setFileCopyFeedback(null), 1500)
    } catch (err) {
      console.error('Failed to copy files:', err)
    }
  }, [generatedFiles])

  const handleAttachFile = useCallback(async (files: FileList) => {
    const newFiles: AttachedFile[] = Array.from(files).map((file) => {
      const isImage = file.type.startsWith('image/')
      return {
        file,
        type: isImage ? 'image' : 'file',
        preview: isImage ? URL.createObjectURL(file) : undefined,
        uploadStatus: 'pending' as const,
      }
    })

    // Add files immediately with pending status
    setAttachedFiles((prev) => [...prev, ...newFiles])

    // Upload to Supabase if configured
    if (isSupabaseConfigured()) {
      for (let i = 0; i < newFiles.length; i++) {
        const fileToUpload = newFiles[i]
        const fileIndex = i

        // Update status to uploading
        setAttachedFiles((prev) => prev.map((f, idx) =>
          idx === prev.length - newFiles.length + fileIndex
            ? { ...f, uploadStatus: 'uploading' as const }
            : f
        ))

        try {
          const result = await uploadFile(fileToUpload.file, fileToUpload.type === 'image' ? 'images' : 'files')

          if (!result.success) {
            console.error('Upload failed:', result.error)
            addMessageRef.current?.('system', `Upload failed: ${result.error || 'Unknown error'}. Check Supabase Dashboard → Storage → osborn-storage bucket policies.`)
          }

          setAttachedFiles((prev) => prev.map((f, idx) =>
            idx === prev.length - newFiles.length + fileIndex
              ? {
                  ...f,
                  uploadStatus: result.success ? 'uploaded' as const : 'error' as const,
                  uploadedUrl: result.url,
                  uploadError: result.error,
                }
              : f
          ))
        } catch (err) {
          setAttachedFiles((prev) => prev.map((f, idx) =>
            idx === prev.length - newFiles.length + fileIndex
              ? { ...f, uploadStatus: 'error' as const, uploadError: (err as Error).message }
              : f
          ))
        }
      }
    }
  }, [])

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles((prev) => {
      const file = prev[index]
      if (file.preview) URL.revokeObjectURL(file.preview)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const { state, audioTrack } = useVoiceAssistant()
  const room = useRoomContext()

  useEffect(() => {
    if (state === 'listening' || state === 'speaking' || state === 'thinking') {
      if (!agentConnected) {
        setAgentConnected(true)
        onAgentReady?.()
      }
    }
  }, [state, agentConnected, onAgentReady])

  // ============================================================
  // 0.9.68 — Audio + room instrumentation
  //
  // Captures every LiveKit RoomEvent + audio track lifecycle event so we can
  // correlate frontend-side audio drops with backend TTS abort cascades.
  // Each line is JSON-serializable for easy grep + tooling.
  // ============================================================
  useEffect(() => {
    if (!room) return
    const log = (event: string, data: Record<string, unknown> = {}) => {
      console.log(`[FE-AUDIO] ${event}`, JSON.stringify({ t: new Date().toISOString(), agentState: state, sid: room.name, ...data }))
    }
    log('mount', { sid: room.name, connectionState: room.state, canPlayback: room.canPlaybackAudio })

    const onConnected = () => log('RoomConnected', { sid: room.name })
    const onDisconnected = (reason: unknown) => {
      log('RoomDisconnected', { reason: String(reason) })
      // Reset agent visual state so the UI never freezes on "speaking" / "listening"
      // after a hard disconnect (machine crash, SSE drop, network loss). Only fires
      // on a genuine terminal disconnect — RoomEvent.Reconnecting handles transient
      // blips and does NOT reset state, so reconnect flows are unaffected.
      setAgentState('idle')
    }
    const onReconnecting = () => log('RoomReconnecting')
    const onReconnected = () => log('RoomReconnected')
    const onConnState = (s: ConnectionState) => {
      log('ConnectionStateChanged', { state: s })
      if (s === ConnectionState.Connected) {
        const cts = (window as any).__osbornClickTs
        if (cts) console.log(`⏱️ [connect-timing] +${Date.now() - cts}ms LiveKit browser WebRTC connected`)
      }
    }
    const onTrackSubscribed = (track: any, pub: any, participant: any) => {
      const isAgent = !participant.isLocal
      const isAudio = track.kind === Track.Kind.Audio
      if (isAgent && isAudio) {
        log('AgentAudioTrackSubscribed', { src: track.source, sid: pub?.trackSid, participant: participant.identity })
        const onMuted = () => log('AgentAudioTrackMuted_LIVE', { sid: pub?.trackSid })
        const onUnmuted = () => log('AgentAudioTrackUnmuted_LIVE', { sid: pub?.trackSid })
        const onEnded = () => log('AgentAudioTrackEnded', { sid: pub?.trackSid })
        track.on?.('muted', onMuted)
        track.on?.('unmuted', onUnmuted)
        track.on?.('ended', onEnded)
      } else {
        log('TrackSubscribed', { kind: track.kind, participant: participant.identity })
      }
    }
    const onTrackUnsubscribed = (track: any, pub: any, participant: any) =>
      log('TrackUnsubscribed', { kind: track.kind, participant: participant.identity, sid: pub?.trackSid })
    const onTrackMuted = (pub: any, participant: any) =>
      log('TrackMuted', { kind: pub?.kind, participant: participant.identity, sid: pub?.trackSid, isLocal: participant.isLocal })
    const onTrackUnmuted = (pub: any, participant: any) => {
      log('TrackUnmuted', { kind: pub?.kind, participant: participant.identity, sid: pub?.trackSid, isLocal: participant.isLocal })
      // P1.7: a live local audio track means whatever mic error we surfaced
      // (or never showed) is resolved — clear the banner and the denial.
      if (participant.isLocal && pub?.kind === 'audio') { setMicError(null); markMicDenied(false) }
    }
    const onLocalTrackPublished = (pub: any) => {
      if (pub?.kind === 'audio') { setMicError(null); markMicDenied(false) }
    }
    const onActiveSpeakers = (speakers: any[]) =>
      log('ActiveSpeakersChanged', { count: speakers.length, identities: speakers.map(s => s.identity) })
    const onConnQuality = (q: any, p: any) =>
      log('ConnectionQualityChanged', { participant: p.identity, quality: q })
    const onAudioPlayback = () => {
      log('AudioPlaybackStatusChanged', { canPlay: room.canPlaybackAudio })
      // P1.6: canPlaybackAudio === false means the AudioContext is suspended
      // (iOS autoplay policy). Only a user gesture can resume it — surface bar.
      setAudioBlocked(room.canPlaybackAudio === false)
    }
    const onMediaDevicesError = (err: Error) => {
      log('MediaDevicesError', { err: err.message })
      // P1.7 / bug 7cf00ae6: map the DOMException to a small banner, once per
      // browser session per problem (a user-initiated retry may show it again).
      const kind = micErrorKind(err?.name)
      if (!kind) return
      if (kind === 'denied') markMicDenied(true)
      const userRetry = micUserRetryRef.current
      micUserRetryRef.current = false
      if (!userRetry && micBannerShownRef.current.has(kind)) return
      const store = micStore()
      if (!shouldShowMicBanner(store, kind, { userRetry })) return
      noteMicBannerShown(store, kind)
      micBannerShownRef.current.add(kind)
      setMicError(kind)
    }
    const onParticipantConnected = (p: any) =>
      log('ParticipantConnected', { identity: p.identity, isAgent: !p.isLocal })
    const onParticipantDisconnected = (p: any) =>
      log('ParticipantDisconnected', { identity: p.identity, isAgent: !p.isLocal })

    // 0.9.71: high-value FE-only events not present in BE @livekit/rtc-node 0.13.x —
    // surface them so any audio/interruption regression has a paired signal here.
    const onLocalAudioSilence = (publication: any) =>
      log('LocalAudioSilenceDetected', { sid: publication?.trackSid, source: publication?.source })
    const onMediaDevicesChanged = () =>
      log('MediaDevicesChanged')
    const onActiveDeviceChanged = (kind: string, deviceId: string) =>
      log('ActiveDeviceChanged', { kind, deviceId })
    const onTrackStreamState = (pub: any, state: any, p: any) =>
      log('TrackStreamStateChanged', { participant: p?.identity, kind: pub?.kind, sid: pub?.trackSid, state })
    const onMetricsReceived = (m: any, p: any) =>
      log('MetricsReceived', { participant: p?.identity, type: (m as any)?.type, label: (m as any)?.label })
    const onTranscriptionReceived = (segments: any[], p: any) =>
      log('TranscriptionReceived', { participant: p?.identity, segmentCount: segments?.length, lastText: segments?.[segments.length - 1]?.text?.slice(0, 80) })
    const onDCBufferStatus = (full: boolean, kind: any) =>
      log('DCBufferStatusChanged', { full, kind })
    const onParticipantPermissions = (prev: any, p: any) =>
      log('ParticipantPermissionsChanged', { participant: p?.identity, canPublish: (p as any)?.permissions?.canPublish })
    const onParticipantActive = (p: any) =>
      log('ParticipantActive', { identity: p?.identity })
    const onSignalConnected = () => log('SignalConnected')
    const onSignalReconnecting = () => log('SignalReconnecting')

    room.on(RoomEvent.Connected, onConnected)
    room.on(RoomEvent.Disconnected, onDisconnected)
    room.on(RoomEvent.Reconnecting, onReconnecting)
    room.on(RoomEvent.Reconnected, onReconnected)
    room.on(RoomEvent.ConnectionStateChanged, onConnState)
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
    room.on(RoomEvent.TrackMuted, onTrackMuted)
    room.on(RoomEvent.TrackUnmuted, onTrackUnmuted)
    room.on(RoomEvent.ActiveSpeakersChanged, onActiveSpeakers)
    room.on(RoomEvent.ConnectionQualityChanged, onConnQuality)
    room.on(RoomEvent.AudioPlaybackStatusChanged, onAudioPlayback)
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError)
    room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished)
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected)
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
    room.on(RoomEvent.LocalAudioSilenceDetected, onLocalAudioSilence)
    room.on(RoomEvent.MediaDevicesChanged, onMediaDevicesChanged)
    room.on(RoomEvent.ActiveDeviceChanged, onActiveDeviceChanged)
    room.on(RoomEvent.TrackStreamStateChanged, onTrackStreamState)
    room.on(RoomEvent.MetricsReceived as any, onMetricsReceived)
    room.on(RoomEvent.TranscriptionReceived, onTranscriptionReceived)
    room.on(RoomEvent.DCBufferStatusChanged, onDCBufferStatus)
    room.on(RoomEvent.ParticipantPermissionsChanged, onParticipantPermissions)
    room.on(RoomEvent.ParticipantActive, onParticipantActive)
    room.on(RoomEvent.SignalConnected, onSignalConnected)
    room.on(RoomEvent.SignalReconnecting, onSignalReconnecting)

    return () => {
      room.off(RoomEvent.Connected, onConnected)
      room.off(RoomEvent.Disconnected, onDisconnected)
      room.off(RoomEvent.Reconnecting, onReconnecting)
      room.off(RoomEvent.Reconnected, onReconnected)
      room.off(RoomEvent.ConnectionStateChanged, onConnState)
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      room.off(RoomEvent.TrackMuted, onTrackMuted)
      room.off(RoomEvent.TrackUnmuted, onTrackUnmuted)
      room.off(RoomEvent.ActiveSpeakersChanged, onActiveSpeakers)
      room.off(RoomEvent.ConnectionQualityChanged, onConnQuality)
      room.off(RoomEvent.AudioPlaybackStatusChanged, onAudioPlayback)
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError)
      room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished)
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected)
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
      room.off(RoomEvent.LocalAudioSilenceDetected, onLocalAudioSilence)
      room.off(RoomEvent.MediaDevicesChanged, onMediaDevicesChanged)
      room.off(RoomEvent.ActiveDeviceChanged, onActiveDeviceChanged)
      room.off(RoomEvent.TrackStreamStateChanged, onTrackStreamState)
      room.off(RoomEvent.MetricsReceived as any, onMetricsReceived)
      room.off(RoomEvent.TranscriptionReceived, onTranscriptionReceived)
      room.off(RoomEvent.DCBufferStatusChanged, onDCBufferStatus)
      room.off(RoomEvent.ParticipantPermissionsChanged, onParticipantPermissions)
      room.off(RoomEvent.ParticipantActive, onParticipantActive)
      room.off(RoomEvent.SignalConnected, onSignalConnected)
      room.off(RoomEvent.SignalReconnecting, onSignalReconnecting)
    }
  }, [room, state])

  // 0.9.71: one-time FE SDK version + room options snapshot
  useEffect(() => {
    if (!room) return
    try {
      const opts: any = (room as any).options ?? {}
      console.log('🧪 [FE-SDK-VERSIONS]', JSON.stringify({
        t: new Date().toISOString(),
        livekitClient: (window as any).__LIVEKIT_CLIENT_VERSION,
        userAgent: navigator.userAgent,
        roomOptions: {
          adaptiveStream: opts.adaptiveStream,
          dynacast: opts.dynacast,
          audioCaptureDefaults: opts.audioCaptureDefaults,
          audioOutput: opts.audioOutput,
          stopLocalTrackOnUnpublish: opts.stopLocalTrackOnUnpublish,
          reconnectPolicy: opts.reconnectPolicy ? '[set]' : '[default]',
        },
      }))
    } catch (err) {
      console.log('🧪 [FE-SDK-VERSIONS] failed:', (err as Error).message)
    }
  }, [room])

  // 0.9.68 — log every agent state transition with precise timestamp.
  // Cross-reference against backend "🤖 State:" logs to see propagation lag.
  useEffect(() => {
    console.log(`[FE-AUDIO] AgentStateChanged`, JSON.stringify({
      t: new Date().toISOString(),
      state,
      hasAudioTrack: !!audioTrack,
      trackMuted: audioTrack?.publication?.isMuted,
      trackSubscribed: audioTrack?.publication?.isSubscribed,
    }))
  }, [state, audioTrack])

  // 0.9.71 — Mic / local-publication observability.
  //   • MediaStreamTrack.getSettings() reveals the browser-applied
  //     echoCancellation / noiseSuppression / autoGainControl / sampleRate /
  //     channelCount values — what the OS actually negotiated, not what we
  //     requested. Critical when diagnosing "agent thinks I'm speaking" / AEC
  //     leakage / mic preprocessing.
  //   • Polled audio-level lets us correlate mic activity at the FE with
  //     backend STT interim/final emissions and user_state_changed timing.
  useEffect(() => {
    if (!localParticipant) return
    const lp = localParticipant as any
    const micPub = lp.getTrackPublication?.(Track.Source.Microphone)
                || lp.getTrack?.(Track.Source.Microphone)
    const mediaTrack: MediaStreamTrack | undefined =
      micPub?.track?.mediaStreamTrack ?? micPub?.mediaStreamTrack
    if (!mediaTrack) {
      console.log('[FE-AUDIO] MicTrack absent at mount', JSON.stringify({
        t: new Date().toISOString(), hasPub: !!micPub,
      }))
      return
    }
    try {
      const settings: MediaTrackSettings = mediaTrack.getSettings?.() ?? {}
      const caps: MediaTrackCapabilities = (mediaTrack as any).getCapabilities?.() ?? {}
      const constraints = mediaTrack.getConstraints?.() ?? {}
      console.log('[FE-AUDIO] MicTrackSettings', JSON.stringify({
        t: new Date().toISOString(),
        label: mediaTrack.label,
        readyState: mediaTrack.readyState,
        muted: mediaTrack.muted,
        enabled: mediaTrack.enabled,
        // What the browser actually applied:
        echoCancellation: (settings as any).echoCancellation,
        noiseSuppression: (settings as any).noiseSuppression,
        autoGainControl: (settings as any).autoGainControl,
        sampleRate: (settings as any).sampleRate,
        channelCount: (settings as any).channelCount,
        deviceId: (settings as any).deviceId,
        latency: (settings as any).latency,
        // What was asked for:
        constraints,
        // What the device supports:
        capabilityFlags: {
          ec: (caps as any).echoCancellation,
          ns: (caps as any).noiseSuppression,
          agc: (caps as any).autoGainControl,
        },
      }))
    } catch (err) {
      console.log('[FE-AUDIO] MicTrackSettings_FAILED', JSON.stringify({
        t: new Date().toISOString(),
        err: err instanceof Error ? err.message : String(err),
      }))
    }

    // Per-track lifecycle: mute / unmute fired directly on the MediaStreamTrack
    // (separate from LiveKit's RoomEvent.TrackMuted which fires on PUBLICATION).
    const onMuteRaw = () => console.log('[FE-AUDIO] MicMediaTrack_MUTED_BY_BROWSER', JSON.stringify({ t: new Date().toISOString(), reason: 'os-level' }))
    const onUnmuteRaw = () => console.log('[FE-AUDIO] MicMediaTrack_UNMUTED_BY_BROWSER', JSON.stringify({ t: new Date().toISOString() }))
    const onEndedRaw = () => console.log('[FE-AUDIO] MicMediaTrack_ENDED', JSON.stringify({ t: new Date().toISOString() }))
    mediaTrack.addEventListener('mute', onMuteRaw)
    mediaTrack.addEventListener('unmute', onUnmuteRaw)
    mediaTrack.addEventListener('ended', onEndedRaw)
    return () => {
      mediaTrack.removeEventListener('mute', onMuteRaw)
      mediaTrack.removeEventListener('unmute', onUnmuteRaw)
      mediaTrack.removeEventListener('ended', onEndedRaw)
    }
  }, [localParticipant])

  // 0.9.71 — Mic publication state from LiveKit (separate from raw track).
  // Tracks whether we have ACTUALLY published audio to the room.
  useEffect(() => {
    if (!localParticipant) return
    const lp = localParticipant as any
    const summary = {
      t: new Date().toISOString(),
      identity: lp.identity,
      isMicrophoneEnabled: lp.isMicrophoneEnabled,
      trackCount: lp.trackPublications?.size ?? 0,
      audioTracks: Array.from(lp.audioTrackPublications?.values?.() ?? []).map((p: any) => ({
        sid: p?.trackSid,
        source: p?.source,
        muted: p?.isMuted,
        subscribed: p?.isSubscribed,
        kind: p?.kind,
      })),
    }
    console.log('[FE-AUDIO] LocalParticipantSnapshot', JSON.stringify(summary))
  }, [localParticipant, (localParticipant as any)?.isMicrophoneEnabled])

  // Debounced mic-off truth signal for the orb (drives micConfirmedOff). Only
  // fires when the agent says "listening" but the mic is actually off and it's
  // not an intentional mute — after a 1.5s grace so the connect gap is quiet.
  useEffect(() => {
    const effectiveState = agentState !== 'idle' ? agentState : state
    const looksBlocked = effectiveState === 'listening' && micEnabled === false && !isMuted
    if (!looksBlocked) { setMicConfirmedOff(false); return }
    const t = setTimeout(() => setMicConfirmedOff(true), 1500)
    return () => clearTimeout(t)
  }, [agentState, state, micEnabled, isMuted])

  const { send: sendToAgent } = useDataChannel('user-input')

  // ── Outputs drawer data flow (L4; UI#13/19) ──────────────────────────────
  // Re-list the session workspace with REPLACE semantics on open, on focus and
  // after file events; fetch a file body only when it is previewed (no storm).
  const sendJson = useCallback((m: Record<string, unknown>) => {
    sendToAgent(new TextEncoder().encode(JSON.stringify(m)), { reliable: true })
  }, [sendToAgent])
  const currentSessionIdRef = useRef(currentSessionId)
  useEffect(() => { currentSessionIdRef.current = currentSessionId }, [currentSessionId])
  const generatedFilesRef = useRef(generatedFiles)
  useEffect(() => { generatedFilesRef.current = generatedFiles }, [generatedFiles])
  const announcedFilesRef = useRef(new Set<string>())
  const [joinedAt] = useState(() => Date.now())
  const [outputsSeenAt, setOutputsSeenAt] = useState(joinedAt)
  // The ONE unread count (bugs 34808f72/59bb7e8d): distinct agent-written
  // paths not yet seen. Fed only by agent file events, so re-lists, favorites
  // syncs and bucket listings can never make it jump. Cleared on open.
  const [unreadOutputs, setUnreadOutputs] = useState<ReadonlySet<string>>(() => new Set())
  const [outputsSyncing, setOutputsSyncing] = useState(false)
  const [outputsSyncError, setOutputsSyncError] = useState(false)
  const [outputsSyncedAt, setOutputsSyncedAt] = useState<number | null>(null)
  const relistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const relistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRelistAtRef = useRef(0)
  const requestRelist = useCallback((force = false) => {
    const sid = currentSessionIdRef.current
    if (!sid) return
    const now = Date.now()
    if (!force && now - lastRelistAtRef.current < 2000) return
    lastRelistAtRef.current = now
    setOutputsSyncing(true)
    setOutputsSyncError(false)
    sendJson({ type: 'get_session_artifacts', sessionId: sid })
    if (relistTimeoutRef.current) clearTimeout(relistTimeoutRef.current)
    // A list over the data-channel size cap is dropped silently: say so.
    relistTimeoutRef.current = setTimeout(() => { setOutputsSyncing(false); setOutputsSyncError(true) }, 10_000)
  }, [sendJson])
  const markOutputsSynced = useCallback(() => {
    if (relistTimeoutRef.current) clearTimeout(relistTimeoutRef.current)
    relistTimeoutRef.current = null
    setOutputsSyncing(false)
    setOutputsSyncError(false)
    setOutputsSyncedAt(Date.now())
  }, [])
  useEffect(() => () => {
    if (relistTimeoutRef.current) clearTimeout(relistTimeoutRef.current)
    if (relistDebounceRef.current) clearTimeout(relistDebounceRef.current)
  }, [])
  // Agent file events: one in-chat card per new file, re-list while visible,
  // and (only if enabled) open the drawer. Called from handleDataMessage via a
  // ref so its subscription deps stay unchanged.
  const onAgentFileEvent = useCallback((filePath: string, fileName: string) => {
    if (!generatedFilesRef.current.some((f) => f.filePath === filePath) && !announcedFilesRef.current.has(filePath)) {
      announcedFilesRef.current.add(filePath)
      setMessages((prev) => [...prev, {
        id: `file-${filePath}`, role: 'system', content: `Saved ${fileName}`, timestamp: new Date(),
        category: 'chat', fileRef: { filePath, fileName },
      }])
    }
    setUnreadOutputs((prev) => markUnread(prev, filePath, outputsVisibleRef.current))
    if (AUTO_OPEN_OUTPUTS_ON_WRITE) {
      panel.openPanel('outputs')
      setSelectedFilePath(filePath)
      setOutputsPreviewPath(filePath)
    }
    if (outputsVisibleRef.current) {
      if (relistDebounceRef.current) clearTimeout(relistDebounceRef.current)
      relistDebounceRef.current = setTimeout(() => requestRelist(true), 1500)
    }
  }, [panel.openPanel, requestRelist])
  const outputsEventsRef = useRef({ onAgentFileEvent, markOutputsSynced })
  outputsEventsRef.current = { onAgentFileEvent, markOutputsSynced }
  // Opening Outputs re-lists; leaving it marks everything seen (clears "New").
  useEffect(() => {
    if (outputsVisible) requestRelist(true)
  }, [outputsVisible, currentSessionId, requestRelist])
  useEffect(() => {
    if (outputsVisible) setUnreadOutputs((prev) => (prev.size ? new Set() : prev))
  }, [outputsVisible])
  const outputsWasVisibleRef = useRef(false)
  useEffect(() => {
    if (!outputsVisible && outputsWasVisibleRef.current) setOutputsSeenAt(Date.now())
    outputsWasVisibleRef.current = outputsVisible
  }, [outputsVisible])
  useEffect(() => {
    if (!outputsVisible) return
    const onFocus = () => { if (document.visibilityState === 'visible') requestRelist() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [outputsVisible, requestRelist])
  // Lazy body fetch: one request per file version, only for the file on screen.
  const contentRequestedRef = useRef(new Set<string>())
  const requestFileContent = useCallback((f: GeneratedFile, force = false) => {
    const key = `${f.filePath}@${toMs(f.updatedAt)}`
    if (!force && contentRequestedRef.current.has(key)) return
    contentRequestedRef.current.add(key)
    // The agent silently ignores a body request outside the folders it serves
    // (e.g. /workspace/report.txt), which would spin "Loading…" forever.
    if (!agentCanServe(f.filePath, f.source)) {
      setGeneratedFiles((prev) => prev.map((x) => (x.filePath === f.filePath ? { ...x, loadError: LOAD_ERROR_OUTSIDE } : x)))
      return
    }
    sendJson(f.source === 'plan'
      ? { type: 'get_plan_file', filePath: f.filePath }
      : { type: 'get_research_artifact', filePath: f.filePath })
  }, [sendJson])
  const shownFilePath = outputsVisible ? outputsPreviewPath : isFilesModalOpen ? (selectedFile?.filePath ?? null) : null
  useEffect(() => {
    if (!shownFilePath) return
    const f = generatedFiles.find((x) => x.filePath === shownFilePath)
    if (!f || f.content !== undefined || f.url || f.loadError) return
    requestFileContent(f)
  }, [shownFilePath, generatedFiles, requestFileContent])
  const reloadFile = useCallback((filePath: string) => {
    const f = generatedFilesRef.current.find((x) => x.filePath === filePath)
    if (!f) return
    setGeneratedFiles((prev) => prev.map((x) => (x.filePath === filePath ? { ...x, loadError: undefined, content: undefined } : x)))
    requestFileContent(f, true)
  }, [requestFileContent])

  const toggleNoiseCancel = useCallback(() => {
    const next = !noiseCancelOn
    setNoiseCancelOn(next) // optimistic; agent confirms via noise_cancel_state
    try {
      const enc = new TextEncoder()
      sendToAgent(enc.encode(JSON.stringify({ type: 'noise_cancel', enabled: next })), { reliable: true })
    } catch {}
  }, [noiseCancelOn, sendToAgent])

  // Track recent messages to prevent duplicates (keep last 5 per role)
  const recentMessagesRef = useRef<{ user: string[]; assistant: string[]; system: string[] }>({
    user: [],
    assistant: [],
    system: [],
  })

  // Stable refs for callbacks to avoid re-subscription issues
  const onAgentReadyRef = useRef(onAgentReady)
  onAgentReadyRef.current = onAgentReady

  // Refs to track session gate state in data handler without causing re-subscriptions
  const sessionGateCompletedRef = useRef(sessionGateCompleted)
  sessionGateCompletedRef.current = sessionGateCompleted
  const showResumePromptRef = useRef(showResumePrompt)
  showResumePromptRef.current = showResumePrompt
  const isMutedRef = useRef(isMuted)
  isMutedRef.current = isMuted
  const localParticipantRef = useRef(localParticipant)
  localParticipantRef.current = localParticipant
  // P1.9 (2026-10-24): wall-clock "TTS audio may still be flushing" marker,
  // stamped on every tts_chunk_playing. The iOS AEC re-enable below refuses to
  // fire inside this window — enabling mid-flush gets the track re-muted by
  // iOS and the mic stays dead for the rest of the turn.
  const ttsActiveUntilRef = useRef(0)

  const addMessageRef = useRef<(role: ChatMessage['role'], content: string, toolName?: string, category?: 'chat' | 'log', toolMeta?: ToolMeta, extra?: { messageId?: string; chunkIndex?: number }) => void>()

  // addMessage function with duplicate detection
  addMessageRef.current = useCallback((role: ChatMessage['role'], content: string, toolName?: string, category?: 'chat' | 'log', toolMeta?: ToolMeta, extra?: { messageId?: string; chunkIndex?: number }) => {
    console.log(`📥 addMessage called: role=${role}, contentLength=${content?.length}, content="${content?.substring(0, 80)}..."`)

    // Safety check - skip empty/whitespace-only messages
    if (!content || typeof content !== 'string' || !content.trim()) {
      console.log(`⏭️ addMessage: skipping empty ${role} message`)
      return
    }

    // Normalize content for comparison (trim, normalize whitespace)
    const normalizedContent = content.trim().replace(/\s+/g, ' ')

    // Tool-call log cards are distinct events (10 reads of the same file are 10
    // real actions) — skip dedup for them so the review log stays complete.
    if (!toolMeta) {
      // Check if this exact content was sent recently (within last 5 messages of this role)
      const recentOfRole = recentMessagesRef.current[role]
      if (recentOfRole.includes(normalizedContent)) {
        console.log(`⏭️ Skipping duplicate ${role} message: "${normalizedContent.substring(0, 50)}..."`)
        return
      }

      // Add to recent messages and trim to last 5
      recentOfRole.push(normalizedContent)
      if (recentOfRole.length > 5) {
        recentOfRole.shift()
      }
    }

    const newMessage: ChatMessage = {
      id: `${Date.now()}-${Math.random()}`,
      role,
      content,
      timestamp: new Date(),
      toolName,
      category: category || 'chat',
      toolMeta,
      messageId: extra?.messageId,
      chunkIndex: extra?.chunkIndex,
    }
    console.log(`✅ Adding ${role} message to state:`, newMessage)
    if (role === 'assistant') dispatchResumeChip({ type: 'assistant' })
    setMessages((prev) => [...prev, newMessage])
  }, [])

  // Handle incoming data messages via callback (more reliable than using message property)
  // The callback fires for EVERY message, while the message property only holds the last one
  const handleDataMessage = useCallback((msg: { payload: Uint8Array }) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload))
      console.log('📨 Received data message:', data.type, data)

      if (data.type === 'agent_ready') {
        const cts = (window as any).__osbornClickTs
        if (cts) console.log(`⏱️ [connect-timing] +${Date.now() - cts}ms agent_ready received → setConnected(true)`)
        setAgentConnected(true)
        // P1.6: catch a suspended AudioContext at agent_ready — BEFORE the
        // first TTS chunk plays into silence. On iOS the connect flow starts
        // without a direct tap on this page, so this is the common case.
        if (room.canPlaybackAudio === false) setAudioBlocked(true)
        // Clear any stale "running" sub-agent rows. agent_ready = a fresh/cold-started agent
        // session: any flow still marked running here predates it and can NEVER receive its
        // task_completed (its sub-agent was hard-killed on the restart/session-drop that never
        // fired SubagentStop). Without this reset the "Running" panel accumulates orphaned rows
        // forever (observed: 9 stuck "researcher · running"). Real in-flight agents re-announce
        // via agent_started, so this only drops dead rows.
        setBackgroundFlows([])
        onAgentReadyRef.current?.()
        // Store sessions from agent_ready if provided
        if (data.sessions && Array.isArray(data.sessions)) {
          setSessions(data.sessions)
        }
        // Store MCP server status from agent_ready
        if (data.mcpServers && Array.isArray(data.mcpServers)) {
          // Merge runtime enabled state with status list
          const enabledKeys: string[] = data.enabledMcpServers || []
          const merged = data.mcpServers.map((s: McpServerStatus) => ({
            ...s,
            enabled: enabledKeys.includes(s.serverKey),
          }))
          setMcpServers(merged)
        }
        // Store skills from agent_ready
        if (data.skills && Array.isArray(data.skills)) {
          setSkills(data.skills)
        }
        // Store named agents from agent_ready (researcher/reasoner/writer)
        if (data.namedAgents && Array.isArray(data.namedAgents)) {
          setNamedAgents(data.namedAgents)
        }
        // Pre-selected session: complete gate immediately (don't need to wait for session list)
        if (!sessionGateCompletedRef.current && !showResumePromptRef.current &&
            (preSelectedSessionId || data.preSelectedSessionId)) {
          console.log('📂 Pre-selected session — skipping session gate')
          setSessionGateCompleted(true)
          setCurrentSessionId(preSelectedSessionId || data.preSelectedSessionId)
        }
        // No preselected session = fresh conversation. Start immediately,
        // no gate. The dashboard is the session picker now — "Continue where
        // you left off", "Resume a session", and every session-list row all
        // route to /chat?session=…, so re-prompting here was redundant (the
        // "Previous Sessions" popup). Users switch sessions mid-chat from the
        // in-chat session browser; the list below keeps it warm.
        else if (!sessionGateCompletedRef.current) {
          setIsLoadingSessions(false)
          setSessionGateCompleted(true)
          if (data.recentSessionId) setRecentSessionId(data.recentSessionId)
          if (data.sessions && Array.isArray(data.sessions)) setSessions(data.sessions)
        }
        // Request slot list so the instances panel populates on connect
        {
          const enc = new TextEncoder()
          sendToAgent(enc.encode(JSON.stringify({ type: 'list_slots' })), { reliable: true })
        }
      } else if (data.type === 'agent_state') {
        setAgentState(data.state)
        // Clear speaking highlight when agent is no longer speaking
        if (data.state !== 'speaking') {
          setSpeakingChunk(null)
        }
        // iOS AEC mutes the mic track during TTS playback. Re-enable it when
        // agent transitions to listening (TTS done) — only if user hasn't
        // intentionally muted themselves via the mute button.
        // P1.9 hardening: (a) skip while TTS audio may still be flushing
        // (older agents emit `listening` with chunks queued — enabling then
        // gets re-muted by AEC and the mic stays dead); (b) try/catch —
        // setMicrophoneEnabled can reject on detached participants; (c) one
        // delayed re-check retry in case the enable landed on the tail of the
        // audio session and was silently dropped.
        // Bug 7cf00ae6: never after a denial — this path (every agent turn and
        // the agent's ~60s direct-mode auto-recovery) re-raised the mic prompt.
        if (data.state === 'listening' && shouldAutoEnableMic({ denied: micDeniedRef.current, muted: isMutedRef.current }) && sessionGateCompletedRef.current) {
          const enableMic = () => {
            if (!shouldAutoEnableMic({ denied: micDeniedRef.current, muted: isMutedRef.current }) || Date.now() < ttsActiveUntilRef.current) return
            try { void localParticipantRef.current?.setMicrophoneEnabled(true) } catch { /* detached participant */ }
          }
          enableMic()
          setTimeout(enableMic, 500)
        }
        // Any voice state change (thinking/speaking/listening) = active session
        onVoiceActivity?.()
      } else if (data.type === 'user_transcript') {
        if (data.text && data.text.trim()) {
          console.log('👤 Adding user message:', data.text.substring(0, 50))
          addMessageRef.current?.('user', data.text)
          // New user turn — clear any lingering chunk highlight
          setSpeakingChunk(null)
          // User spoke — strongest activity signal, always reset idle timer
          onVoiceActivity?.()
        }
      } else if (data.type === 'tts_chunk_playing') {
        // P1.9: mark the AEC no-fly window (see ttsActiveUntilRef above).
        ttsActiveUntilRef.current = Date.now() + 1200
        if (data.messageId != null && data.chunkIndex != null) {
          setSpeakingChunk({ messageId: data.messageId, chunkIndex: data.chunkIndex })
        }
      } else if (data.type === 'assistant_response') {
        console.log('🤖 RAW assistant_response:', {
          hasText: !!data.text,
          textType: typeof data.text,
          textLength: data.text?.length,
          textPreview: data.text?.substring(0, 100),
          source: data.source,
          fullData: data
        })
        if (data.text && data.text.trim()) {
          console.log('🤖 Adding assistant message:', data.text.substring(0, 50), `[source: ${data.source || 'unknown'}]`)
          addMessageRef.current?.('assistant', data.text, undefined, undefined, undefined, data.messageId ? { messageId: data.messageId } : undefined)
        } else {
          console.warn('⚠️ assistant_response had empty or invalid text:', data)
        }
      } else if (data.type === 'system') {
        // System messages from agent (task info, etc.)
        if (data.text && data.text.trim()) {
          console.log('⚙️ Adding system message:', data.text.substring(0, 50))
          addMessageRef.current?.('system', data.text, undefined, 'log')
        }
      } else if (data.type === 'research_task_started') {
        // Research started — show inline spinner in chat
        console.log('🔬 Research started:', data.task)
        setActiveResearch({ taskId: data.taskId, task: data.task, toolCount: 0 })
      } else if (data.type === 'research_task_complete') {
        // Research finished — replace spinner with summary
        console.log('✅ Research complete:', data.taskId)
        setActiveResearch(null)
        if (data.summary) {
          addMessageRef.current?.('system', data.summary, undefined, 'log')
        }
      } else if (data.type === 'agent_started') {
        // Background flow began
        if (data.agent_id) {
          console.log('🚀 Background flow started:', data.agent_type, data.agent_id)
          setBackgroundFlows(prev => {
            // Avoid duplicates if event fires twice
            if (prev.some(f => f.agentId === data.agent_id)) return prev
            const task = typeof data.task === 'string' && data.task.trim() ? data.task.trim() : undefined
            return [...prev, { agentId: data.agent_id, agentType: data.agent_type ?? 'agent', status: 'running', task, startedAt: Date.now() }]
          })
        }
      } else if (data.type === 'noise_cancel_state') {
        setNoiseCancelOn(!!data.enabled)
        if (data.reason === 'silence') console.log('🚪 Noise cancellation auto-exited (5 min quiet)')
      } else if (data.type === 'gate_dropped' && typeof data.text === 'string') {
        // Tombstone — dropped utterances stay visible and recoverable
        setGateDropped(prev => [...prev.slice(-49), { text: data.text, verdict: data.verdict ?? 'side_talk', ts: data.ts ?? Date.now() }])
      } else if (data.type === 'agent_stopped' && data.agent_id) {
        if (data.stopped === false && (data.runningTasks ?? 0) > 0) {
          // Stop failed to correlate while tasks are still live — keep/restore the
          // row so a spared runaway never becomes invisible and unstoppable.
          console.log('⚠️ Stop failed — task(s) still running:', data.agent_id)
          setBackgroundFlows(prev => {
            const existing = prev.find(f => f.agentId === data.agent_id)
            if (existing) return prev.map(f => f.agentId === data.agent_id ? { ...f, lastMessage: 'stop failed — still running' } : f)
            return [...prev, { agentId: data.agent_id, agentType: 'agent', status: 'running', lastMessage: 'stop failed — still running', startedAt: Date.now() }]
          })
        } else {
          console.log('🛑 Background flow stopped:', data.agent_id)
          setBackgroundFlows(prev => prev.filter(f => f.agentId !== data.agent_id))
        }
      } else if (data.type === 'task_completed' && data.agent_id) {
        // Background flow finished (the shape with agent_id)
        console.log('✅ Background flow completed:', data.agent_id)
        setBackgroundFlows(prev =>
          prev.map(f =>
            f.agentId === data.agent_id
              ? { ...f, status: 'completed', artifact: data.last_assistant_message?.substring(0, 120) ?? f.artifact }
              : f
          )
        )
      } else if (data.type === 'tool_use') {
        // Rich tool log card. The agent sends TWO events per tool call:
        //   1. status=running  — tool has started (show spinner)
        //   2. status=completed — tool finished (resolve spinner)
        //
        // Bug fix: the completed event must UPDATE the existing running row
        // in place rather than appending a new message. We find the most recent
        // message whose toolMeta.tool matches AND whose status is still 'running'
        // and flip it to 'completed' (merging in any extra fields the agent
        // sends on completion, e.g. diff, linesAdded). Only if no such pending
        // row exists do we append a new entry (defensive fallback).
        const toolMeta: ToolMeta = {
          tool: data.tool,
          status: data.status === 'completed' ? 'completed' : 'running',
          filePath: data.filePath,
          fileName: data.fileName,
          command: data.command,
          pattern: data.pattern,
          url: data.url,
          description: data.description,
          linesAdded: data.linesAdded,
          linesRemoved: data.linesRemoved,
          editCount: data.editCount,
          diff: data.diff,
          agentRole: data.agentRole,
        }
        // Human summary line (also used as the message content / fallback).
        const target = data.fileName || data.command || data.pattern || data.url || ''
        // Live sub-agent progress: a tool_use tagged with agentId belongs to a running
        // sub-agent — surface it on that Running row so you can watch it work. Reuses the
        // existing tool stream; no separate channel. (Log-feed card below is unchanged.)
        if (data.agentId) {
          const label = target ? `${data.tool}: ${target}` : `Using ${data.tool}`
          setBackgroundFlows(prev => prev.map(f =>
            f.agentId === data.agentId && f.status === 'running' ? { ...f, lastMessage: label } : f
          ))
        }
        if (data.status === 'completed') {
          // Find and update the most recent running row for this tool.
          setMessages((prev) => {
            // Walk backwards to find the last 'running' entry for this tool.
            for (let i = prev.length - 1; i >= 0; i--) {
              const m = prev[i]
              if (m.toolMeta?.tool === data.tool && m.toolMeta?.status === 'running') {
                const updated: ChatMessage = {
                  ...m,
                  toolMeta: { ...m.toolMeta, ...toolMeta, status: 'completed' },
                }
                return [...prev.slice(0, i), updated, ...prev.slice(i + 1)]
              }
            }
            // No pending row found — append a completed entry as fallback.
            const msg = target ? `${data.tool}: ${target}` : data.tool
            return [...prev, {
              id: `${Date.now()}-${Math.random()}`,
              role: 'system' as const,
              content: msg,
              timestamp: new Date(),
              toolName: data.tool,
              category: 'log' as const,
              toolMeta,
            }]
          })
        } else {
          // Running: always append a new row with the spinner.
          const msg = target ? `Using ${data.tool}: ${target}` : `Using ${data.tool}`
          addMessageRef.current?.('system', msg || data.tool, data.tool, 'log', toolMeta)
        }
        // Outputs (bugs 34808f72/59bb7e8d): a completed Write/Edit is a file
        // Osborn made, wherever it lives. Workspace files also get an artifact
        // event; both land on the same row and the same unread entry.
        const written = fileFromToolEvent(data, { sessionId: currentSessionIdRef.current, now: Date.now() })
        if (written) {
          outputsEventsRef.current.onAgentFileEvent(written.filePath, written.fileName)
          setGeneratedFiles((prev) => upsertAgentFile(prev, written as GeneratedFile))
        }
        // Increment research tool counter
        setActiveResearch(prev => prev ? { ...prev, toolCount: prev.toolCount + 1 } : null)
      } else if (data.type === 'task_review') {
        // Dispatcher verdict from the auto-review gate.
        // verdict: 'REJECT' (reviewer) | 'NEEDS-MORE' (reasoner research-gate)
        const reviewRole = data.verdict === 'NEEDS-MORE' ? 'reasoner' : 'reviewer'
        const reviewMeta: ToolMeta = {
          tool: 'Review',
          status: 'completed',
          agentRole: reviewRole,
          description: `${data.verdict}: ${data.review ?? ''}`,
        }
        addMessageRef.current?.(
          'system',
          `${data.verdict}: ${data.review ?? ''}`,
          'Review',
          'log',
          reviewMeta,
        )
      } else if (data.type === 'claude_output') {
        // Raw Claude output for chat bubbles (full formatting preserved)
        console.log('🤖 Claude output:', {
          textLength: data.text?.length,
          isStreaming: data.isStreaming,
          isFinal: data.isFinal,
          agentRole: data.agentRole,
          preview: data.text?.substring(0, 100)
        })
        if (data.text && data.text.trim()) {
          // Direct mode: show as main chat message (visible immediately)
          // Realtime mode: show as log (research agent output, not primary chat)
          const category = data.agentRole === 'direct' ? 'chat' : 'log'
          // Compaction inline bubble — surfaces in this handler because the
          // agent uses claude_output as the carrier (see buildOnCompactionEvent
          // in agent/src/index.ts). If the bubble doesn't show, look here:
          // is the text empty? is agentRole something other than 'direct'?
          if (data.text.startsWith('🧠')) {
            console.log('[COMPACT-FRONTEND-BUBBLE] adding compaction chat bubble, category=', category, 'preview=', data.text.substring(0, 80))
          }
          addMessageRef.current?.('assistant', data.text, undefined, category, undefined, data.messageId != null ? { messageId: data.messageId, chunkIndex: data.chunkIndex } : undefined)
        }
      } else if (data.type === 'permission_request') {
        // YOLO intercept: if the user has turned on auto-approve, respond
        // immediately with `allow` and skip the modal entirely. The agent
        // still sends requests (we don't want to teach it to stop asking —
        // server-side write safety lives in its PreToolUse hook) we just
        // answer them instantly here.
        if (autoApprovePermissionsRef.current) {
          const filePath = data.input?.file_path
          const payload = new TextEncoder().encode(JSON.stringify({
            type: 'permission_response',
            response: 'allow',
            ...(filePath ? { filePath: String(filePath) } : {}),
          }))
          sendToAgent(payload, { reliable: true })
          console.log(`⚡ [perm] auto-approved (YOLO on): ${data.toolName}`)
          addMessageRef.current?.('system', `Auto-approved: ${data.toolName}`, undefined, 'log')
          return
        }
        setPendingPermission({
          toolName: data.toolName,
          description: data.description,
          input: data.input,
          riskLevel: getToolRiskLevel(data.toolName),
          diff: data.diff,
        })
        console.log(`🔍 [perm] received permission_request: diff=${data.diff ? `✅ ${data.diff.length} chars` : '❌ NONE'} toolName=${data.toolName}`)
      } else if (data.type === 'permission_response') {
        setPendingPermission(null)
      } else if (data.type === 'status_update') {
        // Status updates from background tasks
        if (data.summary && data.summary.trim()) {
          console.log('📊 Status update:', data.summary.substring(0, 50))
          // Only show meaningful status updates, not "No active tasks"
          if (!data.summary.includes('No active tasks')) {
            addMessageRef.current?.('system', data.summary, undefined, 'log')
          }
        }
      } else if (data.type === 'progress_update') {
        // Real-time progress updates during research
        if (data.text && data.text.trim()) {
          console.log('🔄 Progress update:', data.text.substring(0, 50))
          addMessageRef.current?.('system', `Progress: ${data.text}`, undefined, 'log')
        }
      } else if (data.type === 'sessions_list') {
        // Received list of previous sessions
        console.log('📋 Sessions list:', data.sessions?.length || 0)
        setSessions(data.sessions || [])
        setIsLoadingSessions(false)
      } else if (data.type === 'current_session') {
        // Current session info
        console.log('📋 Current session:', data.sessionId)
        setCurrentSessionId(data.sessionId || null)
      } else if (data.type === 'session_resume_set') {
        // Session resume confirmation
        if (data.success) {
          console.log('🔄 Session resume set:', data.sessionId)
          setCurrentSessionId(data.sessionId)
          dispatchResumeChip({ type: 'start', label: resumeChipLabel(), now: Date.now() })
        } else {
          console.log('❌ Session resume failed:', data.error)
          dispatchResumeChip({ type: 'clear' })
          addMessageRef.current?.('system', `❌ ${data.error || 'Failed to resume session'}`)
        }
      } else if (data.type === 'session_resume_failed') {
        // SDK created a new session instead of resuming the requested one
        console.warn('⚠️ Session resume verification failed:', data)
        dispatchResumeChip({ type: 'clear' })
        addMessageRef.current?.('system', `⚠️ Could not restore previous session. Starting fresh conversation.`)
        setCurrentSessionId(data.actualSessionId)
      } else if (data.type === 'session_switched') {
        // Handle mid-conversation session switch
        if (data.success) {
          setCurrentSessionId(data.sessionId)

          // Clear previous session's files — but keep favorites pinned so the
          // user's starred files survive the switch (they're cross-session).
          setGeneratedFiles(favoriteFiles)
          setUnreadOutputs(new Set())
          setSelectedFilePath(null)

          // Clear current chat messages before showing new context
          setMessages([])

          // Show previous session context if available
          if (data.conversationHistory?.length > 0) {
            // Add last few exchanges as context
            addMessageRef.current?.('system', '─── Previous Session Context ───')
            for (const exchange of data.conversationHistory.slice(-3)) {
              addMessageRef.current?.(
                exchange.role === 'user' ? 'user' : 'assistant',
                exchange.content
              )
            }
            addMessageRef.current?.('system', '─── Session Resumed ───')
          }

          // Show summary in chat
          const summary = data.summary
          addMessageRef.current?.('system',
            `🔄 Switched to session (${summary?.messageCount || 0} messages)`
          )
        } else {
          addMessageRef.current?.('system', `❌ Failed to switch: ${data.error}`)
        }
      } else if (data.type === 'plan_file_updated') {
        // Plan file was written/edited by the agent
        console.log('📋 Plan file updated:', data.fileName)
        const fileName = data.fileName || data.filePath.split('/').pop() || 'plan.md'
        outputsEventsRef.current.onAgentFileEvent(data.filePath, fileName)
        setGeneratedFiles((prev) => {
          const existing = prev.findIndex(f => f.filePath === data.filePath)
          const entry: GeneratedFile = {
            filePath: data.filePath,
            fileName,
            type: 'plan',
            source: 'plan',
            updatedAt: new Date(),
            sessionId: currentSessionIdRef.current ?? undefined,
            // An edit of a file we already listed keeps its first-known time, so
            // only files first written in this session count as "Just made".
            createdAt: existing >= 0 ? (prev[existing].createdAt ?? prev[existing].updatedAt) : new Date(),
          }
          if (existing >= 0) {
            const updated = [...prev]
            updated[existing] = { ...updated[existing], ...entry, content: undefined, loadError: undefined }
            return updated
          }
          return [...prev, entry]
        })
        // Auto-request content
        const encoder = new TextEncoder()
        const payload = encoder.encode(JSON.stringify({
          type: 'get_plan_file',
          filePath: data.filePath,
        }))
        sendToAgent(payload, { reliable: true })
        // No auto-open (UI#17): the Outputs badge counts it instead.
      } else if (data.type === 'plan_file_content') {
        // Plan file content received
        console.log('📋 Plan file content received:', data.fileName, data.content?.length || 0, 'chars')
        setGeneratedFiles((prev) => prev.map(f =>
          f.filePath === data.filePath
            ? (data.error
                ? { ...f, content: undefined, loadError: String(data.error) }
                : { ...f, content: data.content ?? '', loadError: undefined })
            : f
        ))
      } else if (data.type === 'research_artifact_updated') {
        // Research artifact was written/edited by the agent
        console.log('🔬 Research artifact updated:', data.fileName)
        const fileName = data.fileName || data.filePath.split('/').pop() || 'artifact'
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        let fileType: GeneratedFile['type'] = 'other'
        if (fileName.includes('plan')) fileType = 'plan'
        else if (ext === 'mmd' || ext === 'mermaid') fileType = 'diagram'
        else if (ext === 'html' || ext === 'htm') fileType = 'html'
        else if (ext === 'md') fileType = 'notes'
        else if (ext === 'svg') fileType = 'diagram'
        else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) fileType = 'image'
        else if (fileName.includes('summary')) fileType = 'summary'

        outputsEventsRef.current.onAgentFileEvent(data.filePath, fileName)
        setGeneratedFiles((prev) => {
          const existing = prev.findIndex(f => f.filePath === data.filePath)
          const entry: GeneratedFile = {
            filePath: data.filePath,
            fileName,
            type: fileType,
            source: 'research',
            updatedAt: new Date(),
            sessionId: currentSessionIdRef.current ?? undefined,
            createdAt: existing >= 0 ? (prev[existing].createdAt ?? prev[existing].updatedAt) : new Date(),
          }
          if (existing >= 0) {
            const updated = [...prev]
            updated[existing] = { ...updated[existing], ...entry, content: undefined, loadError: undefined }
            return updated
          }
          return [...prev, entry]
        })
        // Auto-request content
        const encoder = new TextEncoder()
        const payload = encoder.encode(JSON.stringify({
          type: 'get_research_artifact',
          filePath: data.filePath,
        }))
        sendToAgent(payload, { reliable: true })
        // No auto-open (UI#17): the Outputs badge counts it instead.
      } else if (data.type === 'research_artifact_content') {
        // Research artifact content received. Prefer `data.url` (agent
        // uploaded to Supabase Storage — fetch on demand, no data channel
        // strain) over inline `data.content` (legacy fallback path).
        if (data.url) {
          console.log('🔬 Research artifact URL received:', data.fileName, '→', data.url.substring(0, 60) + '...')
        } else {
          console.log('🔬 Research artifact inline content received:', data.fileName, data.isImage ? 'image' : `${data.content?.length || 0} chars`, data.truncated ? '(truncated)' : '')
        }
        setGeneratedFiles((prev) => prev.map(f =>
          f.filePath === data.filePath
            ? {
                ...f,
                url: data.url || undefined,
                // UI#20: never turn an empty or failed payload into the text
                // "Empty file"; the preview shows empty / unavailable / error.
                content: data.url || data.error ? undefined : (data.content ?? ''),
                loadError: data.error ? String(data.error) : undefined,
                // Images go by extension too: the agent's fallback sends isImage:false.
                isImage: !!data.isImage || isImageName(f.fileName),
                mimeType: data.mimeType,
                truncated: data.truncated || false,
                originalSize: data.originalSize,
              }
            : f
        ))
        // Surface meeting-todos.md content into the dedicated meeting panel.
        // The agent writes/edits this file repeatedly while in a meeting, so
        // every research_artifact_content for it should keep the panel fresh.
        if (data.fileName === 'meeting-todos.md' && typeof data.content === 'string') {
          setMeetingTodosContent(data.content)
          setMeetingTodosUpdatedAt(Date.now())
        }
      } else if (data.type === 'session_artifacts') {
        // Bulk load existing session artifacts on resume/switch
        console.log('📁 Session artifacts received:', data.artifacts?.length || 0)
        if (data.artifacts && Array.isArray(data.artifacts)) {
          const listSessionId: string | undefined = typeof data.sessionId === 'string' ? data.sessionId : undefined
          const newFiles: GeneratedFile[] = data.artifacts.map((a: any) => {
            const ext = a.fileName.split('.').pop()?.toLowerCase() || ''
            const isImage = isImageName(a.fileName)
            return {
              filePath: a.filePath,
              fileName: a.fileName,
              type: a.type as GeneratedFile['type'],
              source: 'research' as const,
              updatedAt: new Date(a.updatedAt),
              sessionId: listSessionId,
              isImage,
              mimeType: isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : undefined,
            }
          })

          // UI#13/19: REPLACE this session folder's rows (vanished files go,
          // changed ones refetch lazily). Bodies are fetched only when a file
          // is opened: no per-file request storm at resume.
          setGeneratedFiles((prev) => replaceArtifacts(prev, newFiles, {
            sessionId: listSessionId,
            pinnedPaths: new Set(favoriteFilesRef.current.map((f) => f.filePath)),
          }))
          outputsEventsRef.current.markOutputsSynced()
        }
      } else if (data.type === 'fast_brain_response') {
        // Pipeline mode: Gemini fast brain parallel response — show in main chat for monitoring
        if (data.text && data.text.trim()) {
          // User-facing label only \u2014 the millisecond timing, responseType and
          // toolsUsed were developer telemetry that read as a bug in the chat.
          // They still arrive on `data` for logging below; keep the human marker.
          const label = '\u26A1 Quick take (provisional \u2014 the full answer follows)'
          console.log(`\uD83E\uDDE0\u26A1 Fast brain response:`, data)
          addMessageRef.current?.('assistant', `${label}\n${data.text}`, 'fast-brain', 'chat')
        }
      } else if (data.type === 'mcp_status' || data.type === 'mcp_servers_changed') {
        // MCP server status update
        console.log('🔌 MCP status update:', data.enabledKeys)
        if (data.mcpServers && Array.isArray(data.mcpServers)) {
          const enabledKeys: string[] = data.enabledKeys || []
          const merged = data.mcpServers.map((s: McpServerStatus) => ({
            ...s,
            enabled: enabledKeys.includes(s.serverKey),
          }))
          setMcpServers(merged)
        }
      } else if (data.type === 'mcp_toggle_result') {
        // MCP toggle confirmation from backend
        console.log('🔌 MCP toggle result:', data.serverKey, data.success)
        if (data.success && data.mcpServers && Array.isArray(data.mcpServers)) {
          const enabledKeys: string[] = data.enabledKeys || []
          const merged = data.mcpServers.map((s: McpServerStatus) => ({
            ...s,
            enabled: enabledKeys.includes(s.serverKey),
          }))
          setMcpServers(merged)
        }
      } else if (data.type === 'skills_status') {
        if (data.skills && Array.isArray(data.skills)) {
          setSkills(data.skills)
        }
      } else if (data.type === 'agents_status') {
        if (data.agents && Array.isArray(data.agents)) {
          setNamedAgents(data.agents)
        }
      } else if (data.type === 'skill_content') {
        if (data.content) setViewedSkill({ name: data.name, content: data.content })
      } else if (data.type === 'skill_remove_result') {
        if (data.skills && Array.isArray(data.skills)) {
          setSkills(data.skills)
        }
        setSkillRemoveArm(null)
      } else if (data.type === 'skill_add_result') {
        if (data.success && data.skills) {
          setSkills(data.skills)
          setShowAddSkill(false)
          setNewSkillName('')
          setNewSkillContent('')
        }
      } else if (data.type === 'claude_auth_required') {
        console.log('🔑 Claude auth required')
        setClaudeAuthStatus('required')
        onAuthRequired?.()
      } else if (data.type === 'claude_auth_url') {
        console.log('🔗 Claude auth URL received')
        setClaudeAuthUrl(data.url)
        setClaudeAuthStatus('waiting')
      } else if (data.type === 'claude_auth_waiting_code') {
        console.log('🔑 Claude waiting for auth code')
        setClaudeAuthStatus('waiting_code')
      } else if (data.type === 'claude_auth_submitting') {
        console.log('🔑 Claude submitting auth code')
        setClaudeAuthStatus('submitting')
      } else if (data.type === 'claude_auth_complete') {
        console.log('✅ Claude auth complete')
        setClaudeAuthUrl(null)
        setClaudeAuthStatus('complete')
        // Auto-dismiss after 3 seconds
        setTimeout(() => setClaudeAuthStatus('none'), 3000)
        // Persist the OAuth token to the host-persistent layer so it survives
        // service container restarts (warm→running transitions). Without this,
        // credentials written inside the ephemeral container overlay are lost
        // and the user has to re-authenticate every time the sprite resumes.
        if (data.token) {
          fetch('/api/sandbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'persist-auth', token: data.token }),
          }).then(r => {
            if (r.ok) console.log('✅ OAuth token persisted to sprite host layer')
            else console.warn('⚠️ Failed to persist OAuth token:', r.status)
          }).catch(err => console.warn('⚠️ Failed to persist OAuth token:', err))
        }
      } else if (data.type === 'claude_auth_error') {
        console.log('❌ Claude auth error:', data.message)
        setClaudeAuthStatus('error')
      } else if (data.type === 'meeting_joining') {
        console.log('🎥 Meeting: joining...')
        setMeetingStatus('joining')
        setMeetingError(null)
        setMeetingTodosContent(null)
        setMeetingTodosUpdatedAt(null)
      } else if (data.type === 'meeting_joined') {
        console.log('🎥 Meeting: joined, botId:', data.botId)
        setMeetingBotId(data.botId)
        setMeetingStatus('joined')
      } else if (data.type === 'meeting_left') {
        console.log('🎥 Meeting: left')
        setMeetingBotId(null)
        setMeetingStatus('idle')
        // Keep meetingTodosContent visible after leave — user may want to
        // review the final TODO list. Cleared on next join.
      } else if (data.type === 'meeting_error') {
        console.log('❌ Meeting error:', data.message)
        setMeetingError(data.message)
        setMeetingStatus('error')
        setTimeout(() => { setMeetingStatus('idle'); setMeetingError(null) }, 5000)
      } else if (data.type === 'ide_status') {
        console.log('[IDE] status:', data.status)
        setIdeStatus('starting')
      } else if (data.type === 'ide_ready') {
        console.log('[IDE] ready, url:', data.url)
        setIdeStatus('ready')
        if (data.url) setIdeUrl(data.url)
      } else if (data.type === 'ide_error') {
        console.log('[IDE] error:', data.error)
        setIdeError(data.error ?? 'Unknown IDE error')
        setIdeStatus('error')
        setIdeUrl(null)
        setTimeout(() => { setIdeStatus('idle'); setIdeError(null) }, 5000)
      } else if (data.type === 'ide_stopped') {
        console.log('[IDE] stopped:', data.reason)
        setIdeStatus('idle')
        setIdeError(null)
        setIdeUrl(null)
      } else if (data.type === 'compaction_started') {
        // Detailed logging: if this fires but the banner doesn't update, look at
        // the state setter calls below. If banner DOES update but inline chat
        // bubble doesn't appear, look at the `claude_output` handler — the
        // agent emits a SEPARATE `claude_output` with `agentRole:'direct'` and
        // a 🧠 emoji to add the inline bubble (see agent/src/index.ts
        // buildOnCompactionEvent). Both events should fire in the same tick.
        console.log('[COMPACT-FRONTEND-RX] compaction_started trigger=', data.trigger, 'full=', JSON.stringify(data).substring(0, 200))
        setCompactionStatus('compacting')
        setCompactionStartedAt(Date.now())
        setCompactionStages([{ stage: 'Compaction triggered', detail: data.trigger ?? 'auto', ts: Date.now() }])
        setCompactionSkills([])
      } else if (data.type === 'compaction_progress') {
        console.log('[COMPACT-FRONTEND-RX] compaction_progress stage=', data.stage, 'detail=', data.detail ?? '')
        setCompactionStages(prev => [...prev, { stage: data.stage, detail: data.detail, ts: Date.now() }])
      } else if (data.type === 'bug_report') {
        // bug-reporter skill (agent-side) emitted a bug report. Forward to the
        // backend API which has the Supabase keys and will INSERT the row +
        // upload the log tail. Fire-and-forget — we don't block the voice UI on
        // Supabase round-trips. Errors are logged but not surfaced to the user;
        // the agent already told them "Filed."
        console.log('🪲 Bug report received from agent:', data.reportId, data.payload?.title)
        fetch('/api/sandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'submit-bug-report',
            reportId: data.reportId,
            payload: data.payload,
            context: data.context || {},
            sessionId: preSelectedSessionId ?? null,
          }),
        }).catch((err) => console.error('[bug-report] submit-bug-report failed:', err))
      } else if (data.type === 'compaction_complete') {
        console.log('[COMPACT-FRONTEND-RX] compaction_complete skillsWritten=', data.skillsWritten, 'skills=', data.skillNames, 'full=', JSON.stringify(data).substring(0, 200))
        setCompactionStatus('complete')
        setCompactionSkills(Array.isArray(data.skillNames) ? data.skillNames : [])
        setCompactionStages(prev => [...prev, {
          stage: 'Saved to memory',
          detail: `${data.skillsWritten ?? 0} skill${data.skillsWritten === 1 ? '' : 's'} updated`,
          ts: Date.now(),
        }])
        // Keep the success panel visible for 10s so the user has time to read it
        // (was 3s — far too brief on mobile where compaction announcements arrive
        // mid-voice-response and the user is listening, not staring at the screen).
        setTimeout(() => {
          setCompactionStatus('idle')
          setCompactionStages([])
          setCompactionSkills([])
          setCompactionStartedAt(null)
        }, 10000)
      } else if (data.type === 'slots_list') {
        // Live instances panel: agent replied to list_slots with current slot state
        console.log('[slots] slots_list received:', data.slots)
        if (Array.isArray(data.slots)) {
          setSlots(data.slots as SlotInfo[])
        }
      } else if (data.type === 'background_session_ready') {
        // A spawned background instance came online
        console.log('[slots] background_session_ready slotId=', data.slotId)
        setSpawnPending(false)
        setSpawnError(null)
        // Refresh slot list now that a new slot is ready
        {
          const enc = new TextEncoder()
          sendToAgent(enc.encode(JSON.stringify({ type: 'list_slots' })), { reliable: true })
        }
      } else if (data.type === 'background_session_error') {
        // A background session reported an error. Only surface it as a SPAWN error if a
        // spawn is actually pending — a consumer crash on an ALREADY-ready slot (fires the
        // same event) would otherwise show a misleading "Failed to spawn" banner for an
        // instance that came up fine minutes ago. Post-ready failures just refresh the list
        // (the dead slot drops off) and are logged.
        console.warn('[slots] background_session_error slotId=', data.slotId, 'error=', data.error, 'spawnPending=', spawnPending)
        setSpawnPending((pending) => {
          if (pending) setSpawnError(typeof data.error === 'string' ? data.error : 'Failed to spawn instance')
          return false
        })
        // Refresh anyway to show accurate state
        {
          const enc = new TextEncoder()
          sendToAgent(enc.encode(JSON.stringify({ type: 'list_slots' })), { reliable: true })
        }
      } else if (data.type === 'background_session_spawned') {
        // Early ack: the slot was registered and its subprocess is cold-starting.
        // Readiness still waits for background_session_ready; just refresh the list.
        console.log('[slots] background_session_spawned slotId=', data.slotId)
        {
          const enc = new TextEncoder()
          sendToAgent(enc.encode(JSON.stringify({ type: 'list_slots' })), { reliable: true })
        }
      } else if (data.type === 'background_session_stopped') {
        // Agent killed a background slot. slots_list (sent right after) is the
        // authoritative refresh; just drop the row immediately for snappiness.
        console.log('[slots] background_session_stopped slotId=', data.slotId)
        setSlots(prev => prev.filter(s => s.id !== data.slotId))
      } else if (data.type === 'background_dispatched') {
        // Agent acked a tag-&-continue dispatch to a background session.
        setBgNotice({ kind: 'dispatched', sessionId: String(data.sessionId ?? ''), text: String(data.instruction ?? '') })
      } else if (data.type === 'background_update') {
        // Background session reported a stage/result — surface + auto-dismiss.
        setBgNotice({ kind: 'done', sessionId: String(data.sessionId ?? ''), text: String(data.summary ?? '') })
        setTimeout(() => setBgNotice(null), 12000)
      } else if (data.type === 'process_list') {
        // Agent replied to list_processes — update Machine tab state
        if (Array.isArray(data.processes) && data.memory) {
          setMachineData({ processes: data.processes, totalCount: typeof data.totalCount === 'number' ? data.totalCount : data.processes.length, memory: data.memory })
        }
        // Reconcile stuck "running" rows against the agent's authoritative live set.
        // Self-heals orphans whose task_completed/agent_stopped was lost to a
        // disconnect, and rows belonging to a since-restarted agent process (its
        // activeDispatchIds is empty, so every stale row is swept). Guarded on the
        // field being present (older agents don't send it → skip, never mass-wipe).
        // 10s grace so a just-dispatched row isn't wiped by an in-flight poll that
        // predates its SubagentStart.
        if (Array.isArray(data.activeDispatchIds)) {
          const live = new Set<string>(data.activeDispatchIds)
          const cutoff = Date.now() - 10_000
          setBackgroundFlows(prev => {
            const next = prev.filter(f =>
              f.status !== 'running' ||           // keep completed/other rows untouched
              live.has(f.agentId) ||              // still genuinely running
              (f.startedAt ?? 0) > cutoff         // too fresh to judge — grace window
            )
            if (next.length !== prev.length) {
              console.log(`🧹 Reconciled ${prev.length - next.length} orphaned "running" row(s) against live dispatch set`)
            }
            return next
          })
        }
      } else if (data.type === 'prior_messages') {
        // Fallback path: prior session messages pushed by the agent over the data
        // channel after connect. The PRIMARY path is the mount-time HTTP fetch of
        // /session-messages (parallel with the LiveKit handshake); the prior- id
        // guard dedupes whichever arrives second.
        if (Array.isArray(data.messages) && data.messages.length > 0) {
          console.log(`💬 prior_messages received: ${data.messages.length} messages`)
          const priorItems = buildPriorItems(data.sessionId ?? 'x', data.messages)
          setMessages(prev => {
            // Don't double-inject: skip if we already have prior- prefixed messages
            if (prev.some(m => m.id.startsWith('prior-'))) return prev
            return [...priorItems, ...prev]
          })
        }
      } else if (data.type === 'checkpoint_captured' || data.type === 'tts_chunks') {
        // Informational only — no UI action needed
      } else {
        console.log('❓ Unknown message type:', data.type)
      }
    } catch (e) {
      console.error('❌ Failed to parse data message:', e)
    }
  }, [preSelectedSessionId, sendToAgent])

  // Subscribe to data channel with callback - this fires for EVERY message
  useDataChannel('osborn-updates', handleDataMessage)

  // Poll process list via data channel every 4s when the Machine tab is active.
  // Sends list_processes; agent replies with process_list on osborn-updates.
  // Stops automatically when machineTabActive is false (tab not open).
  useEffect(() => {
    if (!machineTabActive) return
    const enc = new TextEncoder()
    const request = () => {
      sendToAgent(enc.encode(JSON.stringify({ type: 'list_processes' })), { reliable: true })
    }
    request()
    const id = setInterval(request, 4_000)
    return () => clearInterval(id)
  }, [machineTabActive, sendToAgent])

  // Always-on lightweight process poll — feeds the Machine chip badge on the tab
  // switcher even when the Machine tab is not active. 12s interval so we don't
  // spam; the existing process_list handler already routes replies into machineData.
  // Only runs when the Machine tab is NOT active (that poll covers it at 4s already).
  useEffect(() => {
    if (machineTabActive) return  // let the faster tab-active poll handle it
    const enc = new TextEncoder()
    const request = () => {
      try {
        sendToAgent(enc.encode(JSON.stringify({ type: 'list_processes' })), { reliable: true })
      } catch { /* room may not be connected yet — ignore */ }
    }
    // Fire once immediately so the chip populates right away on connect
    request()
    const id = setInterval(request, 12_000)
    return () => clearInterval(id)
  }, [machineTabActive, sendToAgent])

  // Session management handlers
  const handleLoadSessions = useCallback(() => {
    setIsLoadingSessions(true)
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'list_sessions',
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  const handleResumeSession = useCallback((sessionId: string) => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'resume_session',
      sessionId,
    }))
    sendToAgent(payload, { reliable: true })
    dispatchResumeChip({ type: 'start', label: resumeChipLabel(sessionId), now: Date.now() })
  }, [sendToAgent])

  const handleContinueSession = useCallback(() => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'continue_session',
    }))
    sendToAgent(payload, { reliable: true })
    dispatchResumeChip({ type: 'start', label: resumeChipLabel(null, 'continue'), now: Date.now() })
  }, [sendToAgent])

  // Rehydrate the Files explorer from Supabase Storage (the DURABLE copy) for a
  // given session. The agent's `session_artifacts` message only reflects its
  // local disk, which is empty/partial on a fresh cloud machine after resume —
  // so historic files (uploaded to the bucket) vanished from the explorer. This
  // fetch makes the bucket authoritative: every file the user has for this
  // session reappears with a working URL, and any file the agent also listed
  // locally gets the bucket URL grafted on (no duplicates).
  const loadSessionFiles = useCallback(async (sessionId: string) => {
    if (!sessionId) return
    try {
      const res = await fetch(`/api/session-files?sessionId=${encodeURIComponent(sessionId)}`)
      if (!res.ok) return
      const json = await res.json()
      // Exclude internal _-prefixed files (e.g. _favorites.json) — these are
      // implementation artifacts, not user-visible documents.
      const bucketFiles = (Array.isArray(json?.files) ? json.files : []).filter(
        (f: { fileName: string }) => !f.fileName.startsWith('_')
      )
      if (bucketFiles.length === 0) return
      console.log(`📁 Supabase session files for ${sessionId.substring(0, 8)}:`, bucketFiles.length)

      setGeneratedFiles((prev) => {
        const next = [...prev]
        for (const bf of bucketFiles) {
          const idx = next.findIndex((f) => f.fileName === bf.fileName)
          if (idx >= 0) {
            // Bucket is authoritative for location — graft the durable URL on.
            next[idx] = { ...next[idx], url: next[idx].url || bf.url }
          } else {
            next.push({
              filePath: bf.storagePath,
              fileName: bf.fileName,
              url: bf.url,
              type: (bf.type as GeneratedFile['type']) || 'other',
              source: 'research',
              updatedAt: bf.updatedAt ? new Date(bf.updatedAt) : new Date(),
              isImage: !!bf.isImage,
              mimeType: bf.isImage ? `image/${bf.fileName.split('.').pop()?.toLowerCase()}` : undefined,
            })
          }
        }
        return next
      })

      setSelectedFilePath((cur) => cur ?? bucketFiles[0]?.storagePath ?? null)
    } catch (err) {
      console.warn('[session-files] load failed:', err)
    }
  }, [])

  // Whenever we settle on a concrete session id (resume, switch, or a freshly
  // started session), pull that session's durable file list from Supabase.
  useEffect(() => {
    if (currentSessionId) loadSessionFiles(currentSessionId)
  }, [currentSessionId, loadSessionFiles])

  // Compress image to fit within data channel limits
  const compressImage = async (file: File, maxSize: number = 40000): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image()
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!

      img.onload = () => {
        // Start with original size, reduce until under maxSize
        let quality = 0.8
        let scale = 1
        const maxDimension = 800 // Max width/height

        // Scale down if too large
        if (img.width > maxDimension || img.height > maxDimension) {
          scale = maxDimension / Math.max(img.width, img.height)
        }

        canvas.width = img.width * scale
        canvas.height = img.height * scale
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

        // Try to get under maxSize by reducing quality
        let base64 = canvas.toDataURL('image/jpeg', quality)
        while (base64.length > maxSize && quality > 0.1) {
          quality -= 0.1
          base64 = canvas.toDataURL('image/jpeg', quality)
        }

        // If still too large, scale down more
        while (base64.length > maxSize && scale > 0.2) {
          scale -= 0.1
          canvas.width = img.width * scale
          canvas.height = img.height * scale
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          base64 = canvas.toDataURL('image/jpeg', 0.6)
        }

        resolve(base64)
      }

      img.src = URL.createObjectURL(file)
    })
  }

  const handleSendText = useCallback(async (text: string, files?: AttachedFile[]) => {
    let content = text
    const fileData: { name: string; type: string; content: string; url?: string }[] = []

    if (files && files.length > 0) {
      for (const af of files) {
        const isText = !af.file.type.startsWith('image/')

        // Use uploaded URL if available (Supabase), otherwise fall back to base64/text
        if (af.uploadedUrl) {
          fileData.push({
            name: af.file.name,
            type: af.type,
            content: '',  // Empty content since we have URL
            url: af.uploadedUrl,
          })
          content += `\n\n[${af.type === 'image' ? 'Image' : 'File'}: ${af.file.name}](${af.uploadedUrl})`
          console.log(`📤 Using uploaded URL: ${af.uploadedUrl}`)
        } else if (isText) {
          const textContent = await af.file.text()
          const truncatedContent = textContent.length > 10000
            ? textContent.substring(0, 10000) + '\n...[truncated]'
            : textContent
          fileData.push({ name: af.file.name, type: 'text', content: truncatedContent })
          content += `\n\n[File: ${af.file.name}]\n${truncatedContent.substring(0, 2000)}${truncatedContent.length > 2000 ? '...(truncated)' : ''}`
        } else {
          // Compress image if no URL available
          const base64 = await compressImage(af.file, 40000)
          fileData.push({ name: af.file.name, type: 'image', content: base64 })
          content += `\n\n[Image attached: ${af.file.name}]`
          console.log(`📷 Compressed image to ${base64.length} bytes`)
        }
      }
      setAttachedFiles([])
    }

    addMessageRef.current?.('user', content)

    // Build payload — prepend a compact local-time tag so the agent is always
    // clock-aware. The tag is NOT added to the local chat bubble (addMessageRef
    // above uses `content`, which is the raw user text + any file descriptions).
    const payloadObj = {
      type: 'user_text',
      content: addTimeTag() + text,
      files: fileData.length > 0 ? fileData : undefined,
    }
    const payloadStr = JSON.stringify(payloadObj)

    // Send via data channel
    if (payloadStr.length > 60000) {
      console.warn(`⚠️ Payload too large (${payloadStr.length} bytes)`)
      if (isSupabaseConfigured()) {
        // Upload large text/payload to Supabase and send URL instead
        try {
          const blob = new Blob([text], { type: 'text/plain' })
          const uploadFile_ = new File([blob], `paste-${Date.now()}.txt`, { type: 'text/plain' })
          const result = await uploadFile(uploadFile_, 'files')
          if (result.success && result.url) {
            const uploadedPayload = JSON.stringify({
              type: 'user_text',
              content: text.substring(0, 200) + (text.length > 200 ? '...[full content in attached file]' : ''),
              files: [{ name: uploadFile_.name, type: 'text', content: '', url: result.url }],
            })
            const encoder = new TextEncoder()
            sendToAgent(encoder.encode(uploadedPayload), { reliable: true })
            addMessageRef.current?.('system', `Large message uploaded (${(text.length / 1024).toFixed(1)} KB)`)
            return
          }
        } catch (err) {
          console.error('Failed to upload large text to Supabase:', err)
        }
      }
      // Fallback: truncate with clear error
      addMessageRef.current?.('system', `Message too large for data channel (${(payloadStr.length / 1024).toFixed(0)} KB). Configure Supabase Storage to enable large messages.`)
      const truncated = text.substring(0, 50000) + '\n...[truncated — message exceeded size limit]'
      const smallPayload = JSON.stringify({ type: 'user_text', content: truncated })
      const encoder = new TextEncoder()
      sendToAgent(encoder.encode(smallPayload), { reliable: true })
    } else {
      const encoder = new TextEncoder()
      sendToAgent(encoder.encode(payloadStr), { reliable: true })
    }
  }, [sendToAgent])

  const [likedMessageIds, setLikedMessageIds] = useState<Set<string>>(new Set())

  const handleCopyMessage = useCallback((msg: ChatMessage) => {
    const text = msg.role === 'user'
      ? (sanitizeUserTranscript(msg.content) ?? msg.content)
      : msg.content
    navigator.clipboard.writeText(text).catch(() => {})
  }, [])

  const handleLikeMessage = useCallback((msg: ChatMessage) => {
    setLikedMessageIds(prev => {
      const next = new Set(prev)
      if (next.has(msg.id)) { next.delete(msg.id) } else { next.add(msg.id) }
      return next
    })
    const preview = msg.content.replace(/\s+/g, ' ').trim().substring(0, 60)
    handleSendText(`[liked] "${preview}${msg.content.length > 60 ? '...' : ''}"`)
  }, [handleSendText])

  const handleIgnoreMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => prev.filter(m => m.id !== msg.id))
    if (msg.role === 'user') {
      const preview = msg.content.replace(/\s+/g, ' ').trim().substring(0, 60)
      handleSendText(`[ignored: disregard my previous message "${preview}${msg.content.length > 60 ? '...' : ''}"]`)
    }
  }, [handleSendText])

  const handleReplayMessage = useCallback((msg: ChatMessage) => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'replay_message',
      messageId: msg.messageId,
      content: msg.content,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  // Welcome-back injection: if the user returns after a gap of more than 15
  // minutes since their last message, inject a one-time context note over the
  // proven user_text channel so the agent greets them with gap awareness.
  // Only fires when resuming a real prior session (skip fresh starts).
  const WELCOME_BACK_THRESHOLD_MS = 15 * 60 * 1000
  const injectWelcomeBack = useCallback((sessionTimestamp: string | undefined) => {
    if (!sessionTimestamp) return
    const lastTime = new Date(sessionTimestamp)
    if (isNaN(lastTime.getTime())) return
    const now = new Date()
    const elapsedMs = now.getTime() - lastTime.getTime()
    if (elapsedMs < WELCOME_BACK_THRESHOLD_MS) return

    const elapsed = formatElapsed(elapsedMs)
    const lastStr = lastTime.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const nowStr = now.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const note = `[welcome-back] The user just returned after ${elapsed} away (last message ${lastStr}). Current time is ${nowStr}. Greet them naturally with awareness of the gap.`
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({ type: 'user_text', content: note }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  const handleCircleBack = useCallback((noteText: string) => {
    handleSendText(noteText)
  }, [handleSendText])

  const handleLike = useCallback((noteText: string) => {
    handleSendText(noteText)
  }, [handleSendText])

  const handleDislike = useCallback((noteText: string) => {
    handleSendText(noteText)
  }, [handleSendText])

  const handleFavoriteNote = useCallback((fileName: string) => {
    handleSendText(`[favorited] The user favorited the file ${fileName}.`)
  }, [handleSendText])

  // SEED PROMPT — auto-send a ?prompt= starter ONCE on a FRESH session (no
  // preSelectedSessionId) as soon as the agent is connected. This is the whole
  // "Talk about it" / seeded-chat mechanism: no new API, no new route — the
  // same /chat flow + the existing send path, just pre-filled.
  const seedSentRef = useRef(false)
  useEffect(() => {
    if (seedSentRef.current) return
    if (!seedPrompt || preSelectedSessionId) return
    if (!agentConnected) return
    seedSentRef.current = true
    handleSendText(seedPrompt)
    // Clear the stashed seed so a page refresh doesn't re-send it.
    try { sessionStorage.removeItem('voice-native-seed') } catch {}
  }, [agentConnected, seedPrompt, preSelectedSessionId, handleSendText])

  // Wraps toggleFavorite so that starring a file (toggling ON) also sends a
  // note to the agent over the user-input data channel. Un-favoriting is silent.
  const handleToggleFavoriteWithNote = useCallback(async (file: GeneratedFile) => {
    const currentlyFav = favoriteFilesRef.current.some((f) => f.filePath === file.filePath)
    await toggleFavorite(file)
    if (!currentlyFav) {
      handleFavoriteNote(file.fileName)
    }
  }, [toggleFavorite, handleFavoriteNote])

  const handlePermissionResponse = useCallback((response: 'allow' | 'deny' | 'always_allow') => {
    const toolName = pendingPermission?.toolName || 'tool'
    const filePath = pendingPermission?.input?.file_path
    setPendingPermission(null)
    addMessageRef.current?.('system', `Permission ${response}: ${toolName}`)

    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'permission_response',
      response,
      ...(filePath ? { filePath: String(filePath) } : {}),
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, pendingPermission])

  // MCP server toggle handler
  const handleMcpToggle = useCallback((serverKey: string, enabled: boolean) => {
    // Optimistic update
    setMcpServers((prev) => prev.map(s =>
      s.serverKey === serverKey ? { ...s, enabled } : s
    ))
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'mcp_toggle',
      serverKey,
      enabled,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  // Request current MCP status
  const handleLoadMcpStatus = useCallback(() => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'get_mcp_status',
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  // Spawn a second Claude instance (background slot). With no args the agent auto-picks the
  // most-recent non-focused session; passing sessionId (+ its cwd as workingDir) targets a
  // specific one chosen from the picker — the session's cwd MUST be forwarded so --resume
  // resolves the on-disk location.
  const handleSpawnInstance = useCallback((sessionId?: string, workingDir?: string) => {
    if (spawnPending) return
    setSpawnPending(true)
    setSpawnError(null)
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'spawn_background_session',
      ...(sessionId ? { sessionId } : {}),
      ...(workingDir ? { workingDir } : {}),
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, spawnPending])

  // Safety net: if a spawn never reports ready/error (e.g. the background cold-start
  // stalls before system/init under event-loop pressure), clear the stuck "Spawning…"
  // after a bounded wait so the panel doesn't hang forever. background_session_ready /
  // background_session_error flip spawnPending=false first, tearing this timer down.
  useEffect(() => {
    if (!spawnPending) return
    const t = setTimeout(() => {
      setSpawnPending(false)
      setSpawnError('Spawn timed out — the instance didn’t come online. Try again.')
    }, 45000)
    return () => clearTimeout(t)
  }, [spawnPending])

  // Dispatch an instruction to a background session (Pattern #2 P1 — tag & continue).
  // Fire-and-forget: the agent acks with background_dispatched, then later
  // background_update when the background session finishes.
  const handleDispatchBackground = useCallback((targetSessionId: string, instruction: string) => {
    const encoder = new TextEncoder()
    sendToAgent(encoder.encode(JSON.stringify({ type: 'dispatch_background', targetSessionId, instruction })), { reliable: true })
  }, [sendToAgent])

  // Close/stop a background instance. Optimistically drop the row; the agent's
  // slots_list refresh (after it kills the subprocess) is authoritative.
  const handleStopInstance = useCallback((sessionId: string) => {
    const encoder = new TextEncoder()
    sendToAgent(encoder.encode(JSON.stringify({ type: 'stop_background_session', sessionId })), { reliable: true })
    setSlots(prev => prev.filter(s => s.id !== sessionId))
  }, [sendToAgent])

  // Meeting (Recall.ai) handlers
  const handleJoinMeeting = useCallback((meetingUrl: string) => {
    // Cast the meeting CANVAS as the bot's camera+mic (Recall output_media) —
    // /meeting-canvas subscribes to the agent's /canvas-stream and becomes the
    // bot's face (visuals) + voice. Passing castUrl explicitly overrides any
    // stale OSBORN_MEETING_CAST_URL env on the agent (which otherwise points the
    // cast at the bare homepage). agentUrl is the agent's public URL the canvas
    // needs for its SSE subscription.
    const castUrl = agentUrl
      ? `${window.location.origin}/meeting-canvas?agent=${encodeURIComponent(agentUrl)}`
      : undefined
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'join_meeting',
      url: meetingUrl,
      webhookBase: agentUrl,
      ...(castUrl ? { castUrl } : {}),
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, agentUrl])

  const handleLeaveMeeting = useCallback(() => {
    if (!meetingBotId) return
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'leave_meeting',
      botId: meetingBotId,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, meetingBotId])

  const handleOpenEditor = useCallback(() => {
    if (ideStatus === 'ready' && ideUrl) {
      window.open(ideUrl, '_blank')
      return
    }
    if (ideStatus === 'starting') return
    setIdeStatus('starting')
    setIdeError(null)
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({ type: 'start_ide' }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent, ideStatus, ideUrl])

  const handleEditorStop = useCallback(() => {
    const encoder = new TextEncoder()
    sendToAgent(encoder.encode(JSON.stringify({ type: 'stop_ide' })), { reliable: true })
  }, [sendToAgent])

  const handleEditorRestart = useCallback(() => {
    const encoder = new TextEncoder()
    sendToAgent(encoder.encode(JSON.stringify({ type: 'stop_ide' })), { reliable: true })
    setTimeout(() => {
      setIdeStatus('starting')
      setIdeError(null)
      sendToAgent(encoder.encode(JSON.stringify({ type: 'start_ide' })), { reliable: true })
    }, 500)
  }, [sendToAgent])

  // Add a new skill
  // ── Per-user named agents (DB-backed) ──
  // Fetch the signed-in user's user_agents rows once; whenever they change (or
  // the agent [re]connects), push them via set_agents. The agent merges over
  // built-ins and replies agents_status (drives the popover). Guests / no
  // rows → nothing sent, built-ins stand. SDK constraint: edits apply at the
  // NEXT session cold start.
  const [userAgentRows, setUserAgentRows] = useState<UserAgentDraft[] | null>(null)
  // Tombstoned built-ins (user_agents rows with enabled=false): removed from
  // the effective set but always re-addable — defaults are never gone forever.
  const [removedAgentNames, setRemovedAgentNames] = useState<string[]>([])
  // Turbo mode: read from instances.turbo on mount; included in set_agents.
  // Guests / no row → false (agent defaults to real models).
  const [turboMode, setTurboMode] = useState(false)
  useEffect(() => {
    if (!isSupabaseConfigured()) return
    const sb = createSupabaseBrowser()
    sb.auth.getUser().then(({ data }) => {
      if (!data?.user) return
      // Fetch user_agents and instances.turbo in parallel.
      Promise.all([
        sb.from('user_agents').select('name,description,prompt,model,tools,enabled'),
        sb.from('instances').select('turbo').eq('user_id', data.user.id).single(),
      ]).then(([agentsResult, instanceResult]) => {
        const rows = agentsResult.data
        if (Array.isArray(rows)) {
          setUserAgentRows(rows.filter((r: any) => r.enabled) as UserAgentDraft[])
          setRemovedAgentNames(rows.filter((r: any) => !r.enabled).map((r: any) => r.name))
        }
        if (typeof instanceResult.data?.turbo === 'boolean') {
          setTurboMode(instanceResult.data.turbo)
        }
      })
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!agentConnected || userAgentRows === null) return
    const encoder = new TextEncoder()
    sendToAgent(encoder.encode(JSON.stringify({ type: 'set_agents', agents: userAgentRows, removed: removedAgentNames, turbo: turboMode })), { reliable: true })
  }, [agentConnected, userAgentRows, removedAgentNames, turboMode, sendToAgent])

  const handleSaveAgent = useCallback((a: UserAgentDraft) => {
    if (!isSupabaseConfigured()) return
    const sb = createSupabaseBrowser()
    sb.auth.getUser().then(({ data }) => {
      if (!data?.user) return
      const name = a.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
      sb.from('user_agents')
        .upsert({ user_id: data.user.id, name, description: a.description.trim(), prompt: a.prompt.trim(), model: a.model, tools: a.tools, enabled: true, updated_at: new Date().toISOString() }, { onConflict: 'user_id,name' })
        .then(({ error }) => {
          if (error) { console.error('user_agents upsert failed:', error.message); return }
          setUserAgentRows((prev) => {
            const rest = (prev || []).filter((r) => r.name !== name)
            return [...rest, { ...a, name }]
          })
        })
    })
  }, [])

  const handleDeleteAgent = useCallback((name: string, isCustom: boolean) => {
    if (!isSupabaseConfigured()) return
    const sb = createSupabaseBrowser()
    sb.auth.getUser().then(({ data }) => {
      if (!data?.user) return
      if (isCustom) {
        // Custom agent → delete the row outright.
        sb.from('user_agents').delete().eq('user_id', data.user.id).eq('name', name)
          .then(({ error }) => {
            if (error) { console.error('user_agents delete failed:', error.message); return }
            setUserAgentRows((prev) => (prev || []).filter((r) => r.name !== name))
          })
      } else {
        // Built-in default → tombstone (enabled=false). It moves to the
        // "Available to add" list instead of vanishing forever.
        sb.from('user_agents')
          .upsert({ user_id: data.user.id, name, description: '(removed built-in)', prompt: '-', model: 'inherit', tools: [], enabled: false, updated_at: new Date().toISOString() }, { onConflict: 'user_id,name' })
          .then(({ error }) => {
            if (error) { console.error('user_agents tombstone failed:', error.message); return }
            setUserAgentRows((prev) => prev ?? [])
            setRemovedAgentNames((prev) => prev.includes(name) ? prev : [...prev, name])
          })
      }
    })
  }, [])

  const handleRestoreAgent = useCallback((name: string) => {
    if (!isSupabaseConfigured()) return
    const sb = createSupabaseBrowser()
    sb.auth.getUser().then(({ data }) => {
      if (!data?.user) return
      sb.from('user_agents').delete().eq('user_id', data.user.id).eq('name', name)
        .then(({ error }) => {
          if (error) { console.error('user_agents restore failed:', error.message); return }
          setRemovedAgentNames((prev) => prev.filter((n) => n !== name))
          setUserAgentRows((prev) => prev ?? [])
        })
    })
  }, [])

  const handleAddSkill = useCallback((name: string, content: string) => {
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'skill_add',
      name,
      content,
    }))
    sendToAgent(payload, { reliable: true })
  }, [sendToAgent])

  const handleViewSkill = useCallback((folder: string) => {
    const encoder = new TextEncoder()
    sendToAgent(encoder.encode(JSON.stringify({ type: 'skill_get', name: folder })), { reliable: true })
  }, [sendToAgent])

  const handleRemoveSkill = useCallback((folder: string) => {
    const encoder = new TextEncoder()
    sendToAgent(encoder.encode(JSON.stringify({ type: 'skill_remove', name: folder })), { reliable: true })
  }, [sendToAgent])

  // One-tap catalog install: fetch a served skill (same-origin) and add it.
  const handleInstallFromCatalog = useCallback(async (name: string, url: string) => {
    try {
      const content = await fetch(url).then((r) => r.text())
      handleAddSkill(name, content)
    } catch { /* surfaced via missing skill_add_result */ }
  }, [handleAddSkill])

  // Helper: complete the session gate (unmute mic, send session_selected to backend)
  const completeSessionGate = useCallback((sessionId: string | null) => {
    setShowResumePrompt(false)
    setSessionGateCompleted(true)
    // Unmute mic now that user has made their choice (not after a denial:
    // only the user's own Try again re-asks the browser).
    setIsMuted(false)
    if (!micDeniedRef.current) localParticipant?.setMicrophoneEnabled(true)
    // Notify backend of session choice so it can apply resume + send greeting
    const encoder = new TextEncoder()
    const payload = encoder.encode(JSON.stringify({
      type: 'session_selected',
      sessionId,
    }))
    sendToAgent(payload, { reliable: true })
  }, [localParticipant, sendToAgent])

  // Handle auto-resume prompt actions (must be before early returns to maintain hook order)
  const handleResumePromptContinue = useCallback(() => {
    if (recentSessionId) {
      handleResumeSession(recentSessionId)
      // Inject welcome-back note if user was away long enough
      const sessionInfo = sessions.find((s) => s.sessionId === recentSessionId)
      injectWelcomeBack(sessionInfo?.timestamp)
    }
    completeSessionGate(recentSessionId)
  }, [recentSessionId, sessions, handleResumeSession, injectWelcomeBack, completeSessionGate])

  const handleResumePromptStartFresh = useCallback(() => {
    completeSessionGate(null)
    addMessageRef.current?.('system', '🆕 Starting a fresh session')
  }, [completeSessionGate])

  // Panel data, provided once to every right-panel tab and the in-chat cards (L4).
  const openOutputsPreview = useCallback((filePath: string | null) => {
    setOutputsPreviewPath(filePath)
    if (filePath) setSelectedFilePath(filePath)
  }, [])
  const openFileInPanel = useCallback((filePath: string) => {
    openOutputsPreview(filePath)
    panel.openPanel('outputs')
  }, [openOutputsPreview, panel.openPanel])
  const panelData = useMemo<PanelData>(() => ({
    messages,
    generatedFiles,
    slots,
    agentUrl,
    sendToAgent: sendJson,
    sessionId: currentSessionId,
    isController: true,
    outputs: {
      pinnedPaths: favoritePaths,
      previewPath: outputsPreviewPath,
      openPreview: openOutputsPreview,
      togglePin: (f) => { void toggleFavorite(f) },
      pinError,
      dismissPinError: () => setPinError(null),
      retryPin,
      reloadFile,
      copyFile: handleCopyFile,
      copyAll: handleCopyAllFiles,
      copyFeedback: fileCopyFeedback,
      refresh: () => requestRelist(true),
      syncing: outputsSyncing,
      syncError: outputsSyncError,
      lastSyncedAt: outputsSyncedAt,
      joinedAt,
      seenAt: outputsSeenAt,
      unseenCount: unreadOutputs.size,
      expand: () => setIsFilesModalOpen(true),
    },
    panel: { ...panel, openFile: openFileInPanel },
  }), [messages, generatedFiles, slots, agentUrl, sendJson, currentSessionId, favoritePaths, outputsPreviewPath,
    openOutputsPreview, toggleFavorite, pinError, retryPin, reloadFile, handleCopyFile, handleCopyAllFiles,
    fileCopyFeedback, requestRelist, outputsSyncing, outputsSyncError, outputsSyncedAt, joinedAt, outputsSeenAt,
    unreadOutputs, panel, openFileInPanel])

  if (waitingMode) {
    return (
      <>
        {/* Claude Auth Modal — must render even in waiting mode for cloud deployments */}
        {claudeAuthStatus !== 'none' && claudeAuthStatus !== 'complete' && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md mx-4 shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                  <span className="text-xl">🔑</span>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-lg font-semibold text-white">Claude Authentication</h3>
                  <p className="text-sm text-gray-400">
                    {claudeAuthStatus === 'error' ? 'Authentication failed' : 'Sign in to your Anthropic account'}
                  </p>
                </div>
                <button onClick={() => setClaudeAuthStatus('none')}
                  className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-all shrink-0"
                  title="Dismiss">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {claudeAuthStatus === 'required' && (
                <div className="flex items-center gap-2 text-gray-300 text-sm">
                  <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-amber-400 rounded-full" />
                  <span>Preparing login...</span>
                </div>
              )}
              {(claudeAuthStatus === 'waiting' || claudeAuthStatus === 'waiting_code') && claudeAuthUrl && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-300">
                    Sign in with your own Anthropic account &mdash; use this device or your phone.
                  </p>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    After authorizing you&apos;ll land on a page that says
                    &ldquo;connection refused&rdquo; or similar &mdash; that&apos;s expected. The code is in
                    the browser&apos;s address bar: find <code className="text-amber-400">code=</code>&hellip; and
                    copy everything up to the next <code className="text-amber-400">&amp;</code>, then paste
                    it below.
                  </p>
                  <a
                    href={claudeAuthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-full text-center px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors"
                  >
                    Sign in to Claude
                  </a>
                  <div className="mt-3">
                    <label className="block text-xs text-gray-400 mb-1">Paste authentication code:</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={claudeAuthCode}
                        onChange={(e) => setClaudeAuthCode(e.target.value)}
                        placeholder="Paste code here..."
                        className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                      />
                      <button
                        onClick={() => {
                          if (claudeAuthCode.trim()) {
                            const payload = new TextEncoder().encode(JSON.stringify({ type: 'claude_auth_code', code: claudeAuthCode.trim() }))
                            sendToAgent(payload, { reliable: true })
                            setClaudeAuthCode('')
                          }
                        }}
                        disabled={!claudeAuthCode.trim()}
                        className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
                      >
                        Submit
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {claudeAuthStatus === 'waiting_code' && !claudeAuthUrl && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-300">
                    Paste the authentication code from the browser:
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={claudeAuthCode}
                      onChange={(e) => setClaudeAuthCode(e.target.value)}
                      placeholder="Paste code here..."
                      autoFocus
                      className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      onClick={() => {
                        if (claudeAuthCode.trim()) {
                          const payload = new TextEncoder().encode(JSON.stringify({ type: 'claude_auth_code', code: claudeAuthCode.trim() }))
                          sendToAgent(payload, { reliable: true })
                          setClaudeAuthCode('')
                        }
                      }}
                      disabled={!claudeAuthCode.trim()}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Submit
                    </button>
                  </div>
                </div>
              )}
              {claudeAuthStatus === 'submitting' && (
                <div className="flex items-center gap-2 text-gray-300 text-sm">
                  <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-amber-400 rounded-full" />
                  <span>Submitting code to Claude...</span>
                </div>
              )}
              {claudeAuthStatus === 'error' && (
                <div className="space-y-3">
                  <p className="text-sm text-red-400">
                    Authentication failed. The agent will fall back to API key authentication if available.
                  </p>
                  <button
                    onClick={() => setClaudeAuthStatus('none')}
                    className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="w-full p-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <div className="w-3 h-3 bg-amber-500 rounded-full animate-ping absolute" />
              <div className="w-3 h-3 bg-amber-500 rounded-full" />
            </div>
            <span className="text-gray-400 text-sm">
              {claudeAuthStatus !== 'none' ? 'Authenticating Claude...' : 'Connecting to agent...'}
            </span>
          </div>
        </div>
      </>
    )
  }

  return (
    <PanelDataProvider value={panelData}>
      {/* Claude Auth Modal — shown during first-time OAuth flow in cloud deployments */}
      {claudeAuthStatus !== 'none' && claudeAuthStatus !== 'complete' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                <span className="text-xl">🔑</span>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold text-white">Claude Authentication</h3>
                <p className="text-sm text-gray-400">
                  {claudeAuthStatus === 'error' ? 'Authentication failed' : 'Sign in to your Anthropic account'}
                </p>
              </div>
              <button onClick={() => setClaudeAuthStatus('none')}
                className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-all shrink-0"
                title="Dismiss">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {claudeAuthStatus === 'required' && (
              <div className="flex items-center gap-2 text-gray-300 text-sm">
                <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-amber-400 rounded-full" />
                <span>Preparing login...</span>
              </div>
            )}

            {claudeAuthStatus === 'waiting' && claudeAuthUrl && (
              <div className="space-y-3">
                <p className="text-sm text-gray-300">
                  Click below to sign in, then paste the authentication code you receive.
                </p>
                <a
                  href={claudeAuthUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors"
                >
                  Sign in to Claude
                </a>
                <div className="mt-3">
                  <label className="block text-xs text-gray-400 mb-1">Paste authentication code:</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={claudeAuthCode}
                      onChange={(e) => setClaudeAuthCode(e.target.value)}
                      placeholder="Paste code here..."
                      autoFocus
                      className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      onClick={() => {
                        if (claudeAuthCode.trim()) {
                          const payload = new TextEncoder().encode(JSON.stringify({ type: 'claude_auth_code', code: claudeAuthCode.trim() }))
                          sendToAgent(payload, { reliable: true })
                          setClaudeAuthCode('')
                        }
                      }}
                      disabled={!claudeAuthCode.trim()}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Submit
                    </button>
                  </div>
                </div>
              </div>
            )}

            {claudeAuthStatus === 'waiting_code' && (
              <div className="space-y-3">
                <p className="text-sm text-gray-300">
                  Paste the authentication code from the browser:
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={claudeAuthCode}
                    onChange={(e) => setClaudeAuthCode(e.target.value)}
                    placeholder="Paste code here..."
                    autoFocus
                    className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
                  />
                  <button
                    onClick={() => {
                      if (claudeAuthCode.trim()) {
                        const payload = new TextEncoder().encode(JSON.stringify({ type: 'claude_auth_code', code: claudeAuthCode.trim() }))
                        sendToAgent(payload, { reliable: true })
                        setClaudeAuthCode('')
                      }
                    }}
                    disabled={!claudeAuthCode.trim()}
                    className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Submit
                  </button>
                </div>
              </div>
            )}

            {claudeAuthStatus === 'submitting' && (
              <div className="flex items-center gap-2 text-gray-300 text-sm">
                <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-amber-400 rounded-full" />
                <span>Submitting code to Claude...</span>
              </div>
            )}

            {claudeAuthStatus === 'error' && (
              <p className="text-sm text-red-400">
                Authentication failed. Check the agent logs for details. The agent will fall back to API key authentication if available.
              </p>
            )}
          </div>
        </div>
      )}

      {/* P1.6 — iOS autoplay unlock. The whole bar is the gesture: tapping it
          resumes the suspended AudioContext. Sits above everything (z-70);
          disappears via AudioPlaybackStatusChanged once audio can play. */}
      {audioBlocked && (
        <button
          onClick={async () => {
            // startAudio() is livekit-client's official gesture-driven unlock
            // (resumes the internal AudioContext + starts the audio elements).
            try { await room.startAudio() } catch { /* surfaced by re-check */ }
            // Unlock is async; AudioPlaybackStatusChanged usually flips it —
            // re-check both now and slightly later for late-firing browsers.
            setAudioBlocked(room.canPlaybackAudio === false)
            setTimeout(() => setAudioBlocked(room.canPlaybackAudio === false), 250)
          }}
          className="fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-2 bg-amber-400/95 text-black text-sm font-semibold px-4 py-3 touch-manipulation"
          aria-live="polite"
        >
          🔊 Tap to enable sound
        </button>
      )}

      {pendingPermission && (
        <PermissionModal
          permission={pendingPermission}
          onRespond={handlePermissionResponse}
        />
      )}

      {/* Session browser modal - shows list of previous sessions */}
      {showResumePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md mx-4 shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                <span className="text-xl">📂</span>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Previous Sessions</h3>
                <p className="text-sm text-gray-400">Continue or start fresh</p>
              </div>
            </div>

            {/* Session list with date grouping */}
            {isLoadingSessions ? (
              <div className="flex items-center justify-center py-8 text-gray-500 text-sm gap-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Loading sessions...
              </div>
            ) : sessions.length > 0 ? (
              <div className="flex-1 overflow-y-auto space-y-1 mb-4 max-h-96">
                {groupSessionsByDate(sessions).map((group) => (
                  <div key={group.label}>
                    <div className="sticky top-0 bg-gray-900/95 backdrop-blur-sm px-2 py-1.5 border-b border-gray-800/50">
                      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">{group.label}</span>
                    </div>
                    <div className="space-y-1 p-1">
                      {group.sessions.map((session, index) => (
                        <button
                          key={session.sessionId}
                          onClick={() => {
                            handleResumeSession(session.sessionId)
                            injectWelcomeBack(session.timestamp)
                            completeSessionGate(session.sessionId)
                          }}
                          className={`w-full text-left p-3 rounded-lg border transition-colors ${
                            group.label === 'Today' && index === 0
                              ? 'border-amber-500 bg-amber-500/10'
                              : 'border-gray-700 hover:border-gray-500'
                          }`}
                        >
                          <div className="flex justify-between items-start">
                            <span className="text-sm font-medium text-white">
                              {formatTime(session.timestamp)}
                              {group.label === 'Today' && index === 0 && <span className="ml-2 text-amber-400">(Latest)</span>}
                            </span>
                            <span className="text-xs text-gray-500">{session.messageCount} msgs</span>
                          </div>
                          {session.lastMessage && (
                            <p className="text-xs text-gray-400 mt-1 truncate">{deriveSessionTitle(session.lastMessage)}</p>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-400 text-sm mb-4">No previous sessions found.</p>
            )}

            {/* Start Fresh button */}
            <button
              onClick={handleResumePromptStartFresh}
              className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              <span>🆕</span>
              Start Fresh
            </button>
          </div>
        </div>
      )}

      <div className="w-full h-full flex gap-3">
      <div className="flex-1 min-w-0 flex flex-col bg-gray-900 sm:rounded-xl overflow-hidden border-0 sm:border border-gray-800/50">
        {/* Header - Streamlined */}
        <div className="relative z-30 px-1.5 sm:px-3 py-2 border-b border-gray-800/50 bg-gray-900/50 backdrop-blur-sm">
          <div className="flex flex-wrap items-center gap-1 sm:gap-3">
            {/* Visualizer — only visible when speaking */}
            {state === 'speaking' && <VoiceVisualizer state={state} audioTrack={audioTrack} />}

            {/* Status */}
            <StatusIndicator state={agentState !== 'idle' ? agentState : state} isMuted={isMuted} micBlocked={micConfirmedOff} />

            {/* Project/workspace chip — which repo this session is attached to. */}
            {projectName && (
              <span title={sessionCwd || projectName}
                className="hidden sm:inline-flex items-center gap-1 max-w-[150px] shrink-0 px-2 py-0.5 rounded-full bg-gray-800/60 border border-gray-700/50 text-[10px] text-gray-400">
                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                <span className="truncate">{projectName}</span>
              </span>
            )}

            {/* Live clock — sits right beside the status so the time + date read
                at a glance and every screenshot carries a timestamp. */}
            <LiveClock showDate />

            {/* Compaction status pill — header-level summary (always visible during compact) */}
            {compactionStatus !== 'idle' && (
              <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-semibold transition-all duration-300 ${
                compactionStatus === 'compacting'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                  : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
              }`}>
                {compactionStatus === 'compacting' ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-pulse" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l1.8 5.6L19.5 9l-5.7 1.4L12 16l-1.8-5.6L4.5 9l5.7-1.4L12 2zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z" />
                    </svg>
                    <span>Teaching Osborn&hellip;</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span>{compactionSkills.length > 0 ? `Osborn learned · ${compactionSkills.length} skill${compactionSkills.length === 1 ? '' : 's'}` : 'Memory saved'}</span>
                  </>
                )}
              </div>
            )}

            {/* Control Menu (Mode + History + Tools) — hidden on mobile */}
            <div className="hidden sm:block"><ControlMenu
              sessions={sessions}
              currentSessionId={currentSessionId}
              onLoadSessions={handleLoadSessions}
              onResumeSession={handleResumeSession}
              onContinueSession={handleContinueSession}
              isLoadingSessions={isLoadingSessions}
              disabled={!agentConnected}
              mcpServers={mcpServers}
              onMcpToggle={handleMcpToggle}
              onLoadMcpStatus={handleLoadMcpStatus}
              skills={skills}
              onAddSkill={handleAddSkill}
              onViewSkill={handleViewSkill}
              onRemoveSkill={handleRemoveSkill}
              onInstallFromCatalog={handleInstallFromCatalog}
              skillRemoveArm={skillRemoveArm}
              setSkillRemoveArm={setSkillRemoveArm}
              showAddSkill={showAddSkill}
              setShowAddSkill={setShowAddSkill}
              newSkillName={newSkillName}
              setNewSkillName={setNewSkillName}
              newSkillContent={newSkillContent}
              setNewSkillContent={setNewSkillContent}
            /></div>

            {/* Skill viewer modal — mobile-friendly full SKILL.md reader */}
            {viewedSkill && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setViewedSkill(null)}>
                <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                    <h3 className="text-sm font-semibold text-white truncate">📚 {viewedSkill.name}</h3>
                    <button onClick={() => setViewedSkill(null)} className="text-gray-400 hover:text-white text-lg leading-none">×</button>
                  </div>
                  <pre className="flex-1 overflow-auto p-4 text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap font-mono">{viewedSkill.content}</pre>
                </div>
              </div>
            )}

            {/* Spacer — pushes the burger (mobile) / control cluster (desktop)
                to the far right. */}
            <div className="flex-1" />

            {/* Named agents + Skills — desktop header only. On mobile these
                live in the composer control strip next to the input (Claude-
                style), so the top bar carries only status/stats + hangup. */}
            <div className="hidden sm:flex items-center gap-1.5">
              <AgentsPopover agents={namedAgents} disabled={!agentConnected}
                onSaveAgent={handleSaveAgent} onDeleteAgent={handleDeleteAgent}
                removed={removedAgentNames} onRestoreAgent={handleRestoreAgent} />

              <SkillsPopover
                disabled={!agentConnected}
                skills={skills}
                onAddSkill={handleAddSkill}
                onViewSkill={handleViewSkill}
                onRemoveSkill={handleRemoveSkill}
                onInstallFromCatalog={handleInstallFromCatalog}
                skillRemoveArm={skillRemoveArm}
                setSkillRemoveArm={setSkillRemoveArm}
                showAddSkill={showAddSkill}
                setShowAddSkill={setShowAddSkill}
                newSkillName={newSkillName}
                setNewSkillName={setNewSkillName}
                newSkillContent={newSkillContent}
                setNewSkillContent={setNewSkillContent}
              />
              <AudioPopover disabled={!agentConnected} />
            </div>

            {/* Compact Controls — meeting/files/copy hidden on mobile */}
            <div className="flex items-center gap-1.5">
              {/* Meeting button — hidden on mobile */}
              {meetingStatus === 'joined' ? (
                <button
                  onClick={handleLeaveMeeting}
                  className="hidden sm:flex px-2.5 py-1.5 rounded-lg transition-all bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400 text-xs font-medium items-center gap-1.5 border border-green-500/30 hover:border-red-500/30"
                  title="Leave meeting"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  In Meeting
                </button>
              ) : meetingStatus === 'joining' ? (
                <span className="hidden sm:flex px-2.5 py-1.5 rounded-lg bg-yellow-500/20 text-yellow-400 text-xs font-medium items-center gap-1.5 border border-yellow-500/30">
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                  </svg>
                  Joining...
                </span>
              ) : (
                <div className="hidden sm:block relative">
                  <button
                    onClick={() => setShowMeetingInput((v) => !v)}
                    disabled={!agentConnected}
                    aria-label="Join a meeting"
                    data-testid="join-meeting"
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-all ${
                      !agentConnected
                        ? 'bg-gray-800/30 text-gray-600 cursor-not-allowed'
                        : showMeetingInput
                          ? 'bg-amber-500/20 text-amber-400'
                          : 'text-gray-500 hover:bg-gray-800/60 hover:text-gray-200'
                    }`}
                    title={meetingError || 'Join a meeting'}
                  >
                    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    <span className="hidden lg:inline text-xs font-medium">Meeting</span>
                  </button>
                  {showMeetingInput && (
                    <div ref={meetingPopRef} className="absolute top-11 right-0 w-72 max-w-[calc(100vw-1.5rem)] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-[100] p-3">
                      <label className="block text-[11px] font-semibold text-gray-400 mb-1">Join a meeting</label>
                      <p className="text-[10.5px] text-gray-500 leading-snug mb-2">Sends a bot into the Zoom/Meet call to listen and take notes you can act on. It won&rsquo;t speak or share your screen.</p>
                      <input
                        type="url"
                        autoFocus
                        value={meetingUrlInput}
                        onChange={(e) => setMeetingUrlInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && meetingUrlInput.trim()) {
                            handleJoinMeeting(meetingUrlInput.trim())
                            setMeetingUrlInput('')
                            setShowMeetingInput(false)
                          } else if (e.key === 'Escape') setShowMeetingInput(false)
                        }}
                        placeholder="Paste Zoom or Google Meet URL"
                        className="w-full px-2 py-1.5 text-xs bg-gray-950 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500"
                      />
                      <button
                        onClick={() => {
                          if (meetingUrlInput.trim()) {
                            handleJoinMeeting(meetingUrlInput.trim())
                            setMeetingUrlInput('')
                            setShowMeetingInput(false)
                          }
                        }}
                        disabled={!meetingUrlInput.trim()}
                        data-testid="join-meeting-submit"
                        className="mt-2 w-full py-1.5 text-xs bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                      >
                        Send bot to meeting
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Instances panel toggle — hidden on mobile */}
              <div className="hidden sm:block relative">
                <button
                  onClick={() => {
                    const next = !showInstancesPanel
                    setShowInstancesPanel(next)
                    if (next) {
                      // Refresh slot list AND session list whenever the user opens the panel,
                      // so the picker shows current, titled sessions.
                      const enc = new TextEncoder()
                      sendToAgent(enc.encode(JSON.stringify({ type: 'list_slots' })), { reliable: true })
                      handleLoadSessions()
                    }
                  }}
                  disabled={!agentConnected}
                  className={`p-2 rounded-lg transition-all ${
                    !agentConnected
                      ? 'bg-gray-800/30 text-gray-600 cursor-not-allowed'
                      : showInstancesPanel
                        ? 'bg-amber-500/20 text-amber-400'
                        : slots.length > 1 || spawnPending
                          ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                          : 'text-gray-500 hover:bg-gray-800/60 hover:text-gray-200'
                  }`}
                  aria-label="Background agents"
                  title="Background agents — run extra agents in parallel"
                >
                  {/* Two overlapping circles = multi-instance */}
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <circle cx="9" cy="12" r="5" />
                    <circle cx="15" cy="12" r="5" />
                  </svg>
                  {(slots.length > 1 || spawnPending) && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-white text-[10px] rounded-full flex items-center justify-center font-bold">
                      {slots.length || '…'}
                    </span>
                  )}
                </button>
                {showInstancesPanel && (
                  <InstancesPanel
                    slots={slots}
                    sessions={sessions}
                    currentSessionId={currentSessionId}
                    spawnPending={spawnPending}
                    spawnError={spawnError}
                    onSpawn={handleSpawnInstance}
                    onDispatch={handleDispatchBackground}
                    onStopInstance={handleStopInstance}
                    onClose={() => setShowInstancesPanel(false)}
                  />
                )}
              </div>

              {/* More — single labeled overflow consolidating the loose icon
                  row (Files, Auto-approve, Copy all, Noise filter) into one
                  menu. Amber dot signals an active setting inside. */}
              <PanelToggleButton className="hidden sm:flex" />
              <div className="hidden sm:block relative">
                <button
                  onClick={() => setShowHeaderMore(v => !v)}
                  aria-haspopup="menu" aria-expanded={showHeaderMore}
                  className={`flex items-center gap-1 p-2 rounded-lg transition-all ${
                    showHeaderMore ? 'bg-gray-800/60 text-gray-200' : 'text-gray-500 hover:bg-gray-800/60 hover:text-gray-200'
                  }`}
                  title="More controls"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                  {(autoApprovePermissions || noiseCancelOn || (!outputsVisible && unreadOutputs.size > 0)) && (
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-400" />
                  )}
                </button>
                {showHeaderMore && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowHeaderMore(false)} />
                    <div ref={moreMenuRef} role="menu" className="absolute top-11 right-0 z-50 w-60 rounded-xl bg-gray-900 border border-gray-700/70 shadow-2xl overflow-hidden py-1">
                      <button role="menuitem" onClick={() => { setShowHeaderMore(false); panel.openPanel('outputs') }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-gray-300 hover:bg-gray-800/70 transition-colors">
                        <svg className="w-4 h-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                        <span className="flex-1">Outputs</span>
                        {!outputsVisible && unreadOutputs.size > 0 && <span className="text-[11px] font-semibold text-amber-400">{unreadOutputs.size} new</span>}
                      </button>
                      <button role="menuitem" onClick={() => setAutoApprovePermissions(v => !v)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-gray-300 hover:bg-gray-800/70 transition-colors">
                        <svg className={`w-4 h-4 shrink-0 ${autoApprovePermissions ? 'text-amber-400' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                        <span className="flex-1">Auto-approve tools</span>
                        <span className={`text-[11px] font-medium ${autoApprovePermissions ? 'text-amber-400' : 'text-gray-500'}`}>{autoApprovePermissions ? 'ON' : 'OFF'}</span>
                      </button>
                      <button role="menuitem" onClick={() => { setShowHeaderMore(false); toggleNoiseCancel() }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-gray-300 hover:bg-gray-800/70 transition-colors">
                        <svg className={`w-4 h-4 shrink-0 ${noiseCancelOn ? 'text-amber-400' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M3 18a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H5a2 2 0 00-2 2v3zm18 0a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h1a2 2 0 012 2v3z" /></svg>
                        <span className="flex-1">Noise filter</span>
                        <span className={`text-[11px] font-medium ${noiseCancelOn ? 'text-amber-400' : 'text-gray-500'}`}>{noiseCancelOn ? (gateDropped.length ? `${gateDropped.length} filtered` : 'ON') : 'OFF'}</span>
                      </button>
                      <div className="h-px bg-gray-800 mx-2 my-1" />
                      <button role="menuitem" onClick={() => { setShowHeaderMore(false); handleCopyAllMessages() }} disabled={messages.length === 0}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-gray-300 hover:bg-gray-800/70 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        <svg className="w-4 h-4 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                        <span className="flex-1">{copyFeedback ? 'Copied!' : 'Copy all messages'}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Auto-approve, Copy-all, and Noise-filter moved into the "More"
                  menu above — the loose header icon row is consolidated. */}

              {/* Mute button — desktop header only; mobile mute lives in the
                  composer control strip next to the input. */}
              <button
                onClick={toggleMute}
                className={`hidden sm:block p-2 rounded-lg transition-all ${
                  isMuted
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'text-gray-500 hover:bg-gray-800/60 hover:text-gray-200'
                }`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                )}
              </button>

              {/* Disconnect button — DESKTOP header only. On mobile the hangup
                  lives in the composer control strip beside the input (next to
                  Mute), so the top bar carries only status/clock + the burger.
                  shrink-0 keeps it from clipping in the desktop width fight. */}
              {onDisconnect && (
                <button
                  onClick={onDisconnect}
                  aria-label="End session"
                  className="hidden sm:flex shrink-0 items-center justify-center w-10 h-10 ml-2 rounded-lg transition-all bg-red-500/90 text-white hover:bg-red-500"
                  title="End session (saves LiveKit minutes — session stays resumable)"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
                  </svg>
                </button>
              )}
            </div>

            {/* Mobile menu button — far right, by itself. Per the 3-6-9 rule
                (2026-10-24) this sheet is the voice screen's single overflow:
                auto-approve, noise filter, agents, skills, files, copy,
                meeting, history (8 ≤ technical-9 cap). Top bar stays clean:
                status + clock on the left, burger on the right. */}
            <button onClick={() => setShowMobileMenu(true)}
              className="relative sm:hidden shrink-0 min-h-11 min-w-11 flex items-center justify-center rounded-lg bg-gray-800/50 text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 transition-all">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
              {!outputsVisible && panelData.outputs.unseenCount > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-400" aria-label="New outputs" />
              )}
            </button>
          </div>
        </div>

        {/* Prominent compaction banner — sits above chat during PreCompact→PostCompact window.
            Visible for the full duration (typically 1–3 min), rolling stages keep the user
            informed something is happening. Replaces the older 3-second flash pill which
            users routinely missed. */}
        {/* Compaction indicator — SLIM single line. The header already carries a
            "Teaching Osborn…" pill; this is just a quiet one-liner so a frequent
            compaction doesn't dominate the screen. No subtitle, no stage list. */}
        {compactionStatus !== 'idle' && (
          <div className={`flex items-center gap-2 px-3 py-1 border-b text-[11px] transition-all ${
            compactionStatus === 'compacting'
              ? 'bg-amber-500/[0.06] border-amber-500/20 text-amber-200/90'
              : 'bg-emerald-500/[0.06] border-emerald-500/20 text-emerald-200/90'
          }`}>
            {compactionStatus === 'compacting' ? (
              <svg className="w-3 h-3 shrink-0 animate-teach-sheen" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.6L19.5 9l-5.7 1.4L12 16l-1.8-5.6L4.5 9l5.7-1.4L12 2z" /></svg>
            ) : (
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            )}
            <span className="truncate font-medium">
              {compactionStatus === 'compacting'
                ? 'Teaching Osborn…'
                : `Osborn learned · ${compactionSkills.length} skill${compactionSkills.length === 1 ? '' : 's'}`}
            </span>
            <button
              onClick={() => { setCompactionStatus('idle'); setCompactionStages([]); setCompactionSkills([]); setCompactionStartedAt(null) }}
              className="ml-auto shrink-0 p-0.5 rounded text-gray-500 hover:text-gray-200"
              title="Dismiss" aria-label="Dismiss"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        )}

        {/* Background dispatch notice — tag & continue (Pattern #2 P1). Mirrors the
            slim compaction banner above but in sky tones so it reads as a separate,
            informational strip. "dispatched" persists until dismissed; "done"
            auto-dismisses via the setTimeout in the background_update handler. */}
        {bgNotice && (
          <div className="flex items-center gap-2 px-3 py-1 border-b text-[11px] bg-sky-500/[0.06] border-sky-500/20 text-sky-200/90">
            <span className="truncate font-medium">
              {bgNotice.kind === 'dispatched'
                ? `Sent to ${bgNotice.sessionId.slice(0, 8)} — it'll ping you when done.`
                : `${bgNotice.sessionId.slice(0, 8)} finished · ${bgNotice.text.slice(0, 80)}`}
            </span>
            <button onClick={() => setBgNotice(null)} className="ml-auto shrink-0 p-0.5 rounded text-gray-500 hover:text-gray-200" title="Dismiss">✕</button>
          </div>
        )}

        {/* Meeting TODO panel — visible whenever there's meeting-todos.md
            content. Shows a scannable view of the agent's running notes from
            the meeting. Stays visible after leaving the meeting so the user
            can review; cleared on the next meeting join. */}
        {(meetingStatus === 'joined' || meetingTodosContent) && (
          <div className="px-3 sm:px-4 py-2.5 border-b bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-blue-500/10 border-blue-500/30">
            <div className="max-w-3xl mx-auto">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-blue-300 text-sm font-semibold flex items-center gap-1.5">
                  <svg className={`w-3.5 h-3.5 ${meetingStatus === 'joined' ? 'text-blue-400 animate-pulse' : 'text-blue-400/60'}`} fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="6" />
                  </svg>
                  Meeting notes
                </span>
                {meetingStatus === 'joined' && <span className="text-[10px] text-blue-400/70">listening · poll every 30s</span>}
                {meetingTodosUpdatedAt && (
                  <span className="text-[10px] text-gray-500 ml-auto">updated {Math.floor((Date.now() - meetingTodosUpdatedAt) / 1000)}s ago</span>
                )}
              </div>
              {meetingTodosContent ? (
                <div className="text-xs text-gray-300 whitespace-pre-wrap max-h-48 overflow-y-auto font-mono leading-relaxed">
                  {meetingTodosContent}
                </div>
              ) : (
                <div className="text-xs text-gray-500 italic">
                  Waiting for the first transcript chunk…
                </div>
              )}
            </div>
          </div>
        )}

        {/* Chat */}
        <ChatPanel
          messages={messages}
          onSuggestionClick={(text) => handleSendText(text)}
          activeResearch={activeResearch}
          speakingChunk={speakingChunk}
          onCopy={handleCopyMessage}
          onLike={handleLikeMessage}
          onIgnore={handleIgnoreMessage}
          onReplay={handleReplayMessage}
          likedIds={likedMessageIds}
        />

        {/* Logs drawer */}
        <LogsDrawer
          messages={messages.filter(m => m.category === 'log')}
          onCircleBack={handleCircleBack}
          onLike={handleLike}
          onDislike={handleDislike}
          backgroundFlows={backgroundFlows}
          onStopDispatch={(agentId) => {
            const enc = new TextEncoder()
            sendToAgent(enc.encode(JSON.stringify({ type: 'stop_dispatch', agentId })), { reliable: true })
            // Optimistically clear the row locally. A dead/orphaned task can't be
            // stopped agent-side (it no longer exists) so agent_stopped may never
            // come back — the user must always be able to dismiss a stuck row.
            setBackgroundFlows(prev => prev.filter(f => f.agentId !== agentId))
          }}
          machineData={machineData}
          agentMemory={agentMemory}
          onMachineTabActive={setMachineTabActive}
          ideState={ideStatus === 'ready' ? 'running' : ideStatus === 'starting' ? 'starting' : 'stopped'}
          ideUrl={ideUrl ?? undefined}
          onEditorOpen={handleOpenEditor}
          onEditorStop={handleEditorStop}
          onEditorRestart={handleEditorRestart}
          ideError={ideError}
          machineChipRamPct={
            agentMemory?.usedPct ??
            (machineData?.memory
              ? Math.round((machineData.memory.usedMb / Math.max(machineData.memory.totalMb, 1)) * 100)
              : undefined)
          }
          machineChipProcCount={machineData?.totalCount ?? machineData?.processes.length}
        />

        {resumeChip && (
          <div className="mx-3 mt-1.5 flex justify-center" data-testid="resume-chip">
            <span role="status" aria-live="polite"
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-700/70 bg-gray-800/70 px-3 py-1 text-[11px] text-gray-300">
              <svg className="w-3 h-3 animate-spin motion-reduce:animate-none text-amber-400" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {resumeChip.label}
            </span>
          </div>
        )}

        {/* Mic problem (bug 7cf00ae6): small in-flow banner above the
            composer, once per browser session — never a blocking overlay. */}
        {micError && (
          <MicBanner
            kind={micError}
            onDismiss={() => setMicError(null)}
            onRetry={async () => {
              setMicError(null)
              setIsMuted(false)
              micUserRetryRef.current = true
              try { await localParticipant.setMicrophoneEnabled(true) } catch { /* MediaDevicesError re-surfaces it */ }
            }}
          />
        )}

        {/* Mobile composer control strip — 3-6-9 rule (2026-10-24): the voice
            screen's primary actionables are exactly Mic + End (+ the composer
            input itself). Everything that used to live here — Auto/Ask,
            Agents, Skills, Filter — collapsed into the burger sheet (tray
            rule), which sits at 8 rows ≤ the technical-9 cap. */}
        <div {...{ [PANEL_ANCHOR_ATTR]: '' }} className="sm:hidden flex items-center justify-end gap-1.5 px-3 pt-1.5">
          <button
            onClick={toggleMute}
            className={`flex items-center gap-1.5 min-h-11 px-3.5 py-2 rounded-full text-xs font-medium transition-all ${
              isMuted
                ? 'bg-red-500/20 text-red-400'
                : 'text-gray-400 hover:bg-gray-800/60'
            }`}
            title={isMuted ? 'Unmute mic' : 'Mute mic'}
          >
            {isMuted ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" d="M17 14l4-4m0 4l-4-4" /></svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m7 7v3m0-3a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            )}
            <span>{isMuted ? 'Muted' : 'Mic'}</span>
          </button>

          {/* Hangup — rightmost, next to Mute (moved off the top bar). Labeled
              red pill so it's an easy, unmistakable tap target on mobile
              (icon-only 44px round was too small to hit reliably). */}
          {onDisconnect && (
            <button
              onClick={onDisconnect}
              aria-label="End session"
              className="shrink-0 flex items-center gap-1.5 min-h-11 ml-1 px-3.5 py-2 rounded-full bg-red-500/90 text-white text-xs font-semibold hover:bg-red-500 transition-all"
              title="Hang up — end session (saves minutes, session stays resumable)"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
              </svg>
              <span>End</span>
            </button>
          )}
        </div>

        {/* Input */}
        <TextInput
          onSend={handleSendText}
          attachedFiles={attachedFiles}
          onAttachFile={handleAttachFile}
          onRemoveFile={handleRemoveFile}
        />
      </div>

      {/* Right-side living panel (L4): Outputs and future tabs. Replaces the
          unreachable inline files dock; never a full-screen takeover. */}
      <RightPanel />
      </div>

      {/* Mobile Menu Drawer */}
      {showMobileMenu && (
        <div className="fixed inset-0 z-50 sm:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowMobileMenu(false)} />
          <div className="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 rounded-t-2xl max-h-[70vh] overflow-y-auto animate-in slide-in-from-bottom">
            <div className="p-4 space-y-1">
              {/* Handle bar */}
              <div className="w-10 h-1 bg-gray-700 rounded-full mx-auto mb-4" />

              {/* TRAY RULE (2026-08-01): controls hidden from the mobile header
                  COLLAPSE here — the menu is the backup for every viewport-cut
                  control, nothing just disappears. */}

              {/* Auto-approve toggle — hidden from mobile header (sm+ only) */}
              <button onClick={() => setAutoApprovePermissions(v => !v)}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left">
                <svg className={`w-5 h-5 ${autoApprovePermissions ? 'text-amber-400' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span className="text-sm text-gray-200">Auto-approve tools</span>
                <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${autoApprovePermissions ? 'bg-amber-500/25 text-amber-300 border border-amber-500/30' : 'bg-gray-800 text-gray-500 border border-gray-700'}`}>
                  {autoApprovePermissions ? 'ON' : 'OFF'}
                </span>
              </button>

              {/* Noise filter — moved here from the composer strip (3-6-9).
                  The count chip is the send-anyway recovery for the latest
                  tombstoned utterance, same as the old strip chip. */}
              <button onClick={toggleNoiseCancel}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left">
                <svg className={`w-5 h-5 ${noiseCancelOn ? 'text-amber-400' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M3 18a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H5a2 2 0 00-2 2v3zm18 0a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h1a2 2 0 012 2v3z" />
                </svg>
                <span className="text-sm text-gray-200">Noise filter</span>
                {noiseCancelOn && gateDropped.length > 0 && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      // Send-anyway recovery for the latest tombstoned utterance
                      e.stopPropagation()
                      const last = gateDropped[gateDropped.length - 1]
                      if (!last) return
                      try {
                        const enc = new TextEncoder()
                        sendToAgent(enc.encode(JSON.stringify({ type: 'gate_send_anyway', text: last.text })), { reliable: true })
                        setGateDropped(prev => prev.slice(0, -1))
                      } catch {}
                    }}
                    className="ml-auto px-2 py-0.5 rounded-full bg-amber-500/25 text-amber-300 border border-amber-500/30 text-[11px] font-semibold"
                    title={`${gateDropped.length} utterance(s) filtered — tap to send the latest to the agent anyway`}
                  >{gateDropped.length} filtered · send</span>
                )}
                <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${noiseCancelOn ? 'bg-amber-500/25 text-amber-300 border border-amber-500/30' : 'bg-gray-800 text-gray-500 border border-gray-700'} ${noiseCancelOn && gateDropped.length > 0 ? 'hidden' : ''}`}>
                  {noiseCancelOn ? 'ON' : 'OFF'}
                </span>
              </button>

              {/* Agents — opens the header-less AgentsPopover panel (bridge
                  via agentsOpenReq; the sheet closes first so only one
                  surface is up). */}
              <button onClick={() => { setAgentsOpenReq(n => n + 1); setShowMobileMenu(false) }}
                disabled={!agentConnected}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                </svg>
                <span className="text-sm text-gray-200">Agents</span>
                {namedAgents.length > 0 && (
                  <span className="ml-auto text-xs bg-amber-500/30 text-amber-300 px-2 py-0.5 rounded-full">{namedAgents.length}</span>
                )}
              </button>

              {/* Skills — opens the header-less SkillsPopover panel. */}
              <button onClick={() => { setSkillsOpenReq(n => n + 1); setShowMobileMenu(false) }}
                disabled={!agentConnected}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                </svg>
                <span className="text-sm text-gray-200">Skills</span>
                {skills.length > 0 && (
                  <span className="ml-auto text-xs bg-amber-500/30 text-amber-300 px-2 py-0.5 rounded-full">{skills.length}</span>
                )}
              </button>

              {/* Files */}
              <button onClick={() => { panel.openPanel('outputs'); setShowMobileMenu(false) }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span className="text-sm text-gray-200">Outputs</span>
                {!outputsVisible && panelData.outputs.unseenCount > 0 ? (
                  <span className="ml-auto text-xs bg-amber-500 text-gray-900 font-semibold px-2 py-0.5 rounded-full">{panelData.outputs.unseenCount} new</span>
                ) : null}
              </button>

              {/* Copy messages */}
              <button onClick={() => { handleCopyAllMessages(); setShowMobileMenu(false) }}
                disabled={messages.length === 0}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left disabled:opacity-40">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span className="text-sm text-gray-200">Copy All Messages</span>
              </button>

              {/* Meeting — inline input (mobile-friendly, no native prompt).
                  Joined/Joining states mirror the desktop header pill — mobile
                  previously had NO way to leave a meeting. */}
              <div className="w-full px-3 py-2">
                <div className="flex items-center gap-3 mb-2">
                  <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span className="text-sm text-gray-200">
                    {meetingStatus === 'joined' ? 'In meeting' : meetingStatus === 'joining' ? 'Joining meeting…' : 'Join a meeting'}
                  </span>
                </div>
                {meetingStatus === 'joined' ? (
                  <button onClick={() => { handleLeaveMeeting(); setShowMobileMenu(false) }}
                    className="w-full min-h-11 py-2.5 text-sm bg-green-500/15 text-green-400 border border-green-500/30 rounded hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/30 transition-colors">
                    Leave meeting
                  </button>
                ) : meetingStatus === 'joining' ? (
                  <div className="w-full py-2.5 text-sm text-center text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded">
                    Bot is joining…
                  </div>
                ) : (
                  <>
                    <input
                      type="url"
                      value={meetingUrlInput}
                      onChange={(e) => setMeetingUrlInput(e.target.value)}
                      placeholder="Paste Zoom or Google Meet URL"
                      data-testid="join-meeting-mobile"
                      className="w-full px-2 py-2 text-base bg-gray-950 border border-gray-700 rounded text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500"
                    />
                    <button
                      onClick={() => { if (meetingUrlInput.trim()) { handleJoinMeeting(meetingUrlInput.trim()); setMeetingUrlInput(''); setShowMobileMenu(false) } }}
                      disabled={!meetingUrlInput.trim()}
                      className="mt-2 w-full min-h-11 py-2.5 text-sm bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 transition-colors disabled:opacity-50"
                    >
                      Send bot to meeting
                    </button>
                  </>
                )}
              </div>

              {/* Sessions */}
              <button onClick={() => { handleLoadSessions(); setShowMobileMenu(false) }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors text-left">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm text-gray-200">Session History</span>
              </button>

              {/* No Disconnect row (3-6-9, 2026-10-24): the red End pill is a
                  permanent primary control in the composer strip, so a tray
                  duplicate would be dead weight. */}
            </div>
          </div>
        </div>
      )}

      {/* Header-less Agents/Skills panels — driven by the burger sheet's
          Agents/Skills rows via requestOpen. Rendered at top level (not inside
          the sheet) so they survive the sheet closing; their panels are the
          standard viewport-anchored mobile popovers. */}
      <AgentsPopover agents={namedAgents} disabled={!agentConnected}
        onSaveAgent={handleSaveAgent} onDeleteAgent={handleDeleteAgent}
        removed={removedAgentNames} onRestoreAgent={handleRestoreAgent}
        requestOpen={agentsOpenReq} hideTrigger />
      <SkillsPopover
        disabled={!agentConnected}
        skills={skills}
        onAddSkill={handleAddSkill}
        onViewSkill={handleViewSkill}
        onRemoveSkill={handleRemoveSkill}
        onInstallFromCatalog={handleInstallFromCatalog}
        skillRemoveArm={skillRemoveArm}
        setSkillRemoveArm={setSkillRemoveArm}
        showAddSkill={showAddSkill}
        setShowAddSkill={setShowAddSkill}
        newSkillName={newSkillName}
        setNewSkillName={setNewSkillName}
        newSkillContent={newSkillContent}
        setNewSkillContent={setNewSkillContent}
        requestOpen={skillsOpenReq} hideTrigger
      />

      {/* Files Explorer Modal */}
      <FilesExplorerModal
        isOpen={isFilesModalOpen}
        onClose={() => setIsFilesModalOpen(false)}
        files={generatedFiles}
        selectedFilePath={selectedFilePath}
        onSelectFile={setSelectedFilePath}
        onCopyFile={handleCopyFile}
        onCopyAll={handleCopyAllFiles}
        fileCopyFeedback={fileCopyFeedback}
        favoritePaths={favoritePaths}
        onToggleFavorite={handleToggleFavoriteWithNote}
      />
    </PanelDataProvider>
  )
}

/**
 * Default export. VoiceRoom is now a thin adapter — the LiveKitRoom
 * wrapper and all session callbacks live in ChatSessionProvider
 * (see app/chat/layout.tsx). This component is rendered INSIDE the
 * provider's <LiveKitRoom>, so VoiceRoomInner's useRoomContext /
 * useLocalParticipant / useDataChannel hooks work without any
 * prop-drilled connection info.
 */
export default function VoiceRoom({ waitingMode }: VoiceRoomProps) {
  const { disconnect, markAgentReady, markAuthRequired, markVoiceActivity, idleStopped, preSelectedSessionId, agentUrl, seedPrompt } =
    useChatSession()

  if (idleStopped) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center gap-6 p-8">
        <div className="text-4xl">😴</div>
        <div className="text-center">
          <p className="text-lg font-medium text-[var(--text)]">Session paused</p>
          <p className="text-sm text-[var(--muted)] mt-1">No activity for 15 min — machine stopped to save credits</p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-3 bg-[var(--accent)] text-black font-semibold rounded-xl hover:opacity-90 transition-opacity"
        >
          Resume
        </button>
        <button
          onClick={disconnect}
          className="text-sm text-[var(--muted)] hover:text-[var(--text)] transition-colors"
        >
          Back to dashboard
        </button>
      </div>
    )
  }

  return (
    <VoiceRoomInner
      onDisconnect={disconnect}
      onAgentReady={markAgentReady}
      onAuthRequired={markAuthRequired}
      onVoiceActivity={markVoiceActivity}
      waitingMode={waitingMode}
      preSelectedSessionId={preSelectedSessionId}
      agentUrl={agentUrl}
      seedPrompt={seedPrompt}
    />
  )
}
