'use client'

// Data the right-side panel tabs read. Provided ONCE by VoiceRoom (build plan
// L4), so a tab never needs VoiceRoom props threaded to it and new tabs do not
// require VoiceRoom edits. Also hosts the panel open/tab/width state hook,
// persisted in localStorage under `vn-panel`.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ChatMessage, GeneratedFile, SlotInfo } from '../voice/shared'
import {
  PANEL_STORAGE_KEY, DEFAULT_PANEL_STATE, clampPanelWidth, parsePanelState, serializePanelState,
  type PanelState,
} from '@/lib/panel-state'

export interface OutputsData {
  /** filePath of every pinned (favorited) file. */
  pinnedPaths: ReadonlySet<string>
  /** File shown in the Outputs preview (null = list view). */
  previewPath: string | null
  /** Select a file and show its preview (null returns to the list). */
  openPreview: (filePath: string | null) => void
  togglePin: (file: GeneratedFile) => void
  pinError: string | null
  dismissPinError: () => void
  retryPin: () => void
  /** Ask the agent for a file body again (after an error). */
  reloadFile: (filePath: string) => void
  copyFile: (filePath: string) => void
  copyAll: () => void
  copyFeedback: string | null
  /** Re-list the session workspace now (REPLACE semantics). */
  refresh: () => void
  syncing: boolean
  syncError: boolean
  lastSyncedAt: number | null
  /** When this browser joined the session (ms) — the "Just made" cut-off. */
  joinedAt: number
  /** Files updated after this (ms) are "New". */
  seenAt: number
  unseenCount: number
  /** Open the full-screen Files view (the old modal), only via "Expand". */
  expand: () => void
}

export interface PanelControls {
  open: boolean
  tab: string
  widthPct: number
  openPanel: (tab?: string) => void
  closePanel: () => void
  togglePanel: (tab?: string) => void
  setTab: (tab: string) => void
  setWidthPct: (pct: number) => void
  /** Open Outputs on one file (used by the in-chat file card). */
  openFile: (filePath: string) => void
}

export interface PanelData {
  messages: ChatMessage[]
  generatedFiles: GeneratedFile[]
  slots: SlotInfo[]
  agentUrl?: string
  /** Send one JSON message to the agent on the user-input channel (reliable). */
  sendToAgent: (message: Record<string, unknown>) => void
  sessionId: string | null
  /** True while this tab controls the session. Single-controller today; the
   *  listen-only/take-over model (L12) will feed the real value. */
  isController: boolean
  outputs: OutputsData
  panel: PanelControls
}

const PanelDataContext = createContext<PanelData | null>(null)

export const PanelDataProvider = PanelDataContext.Provider

export function usePanelData(): PanelData {
  const ctx = useContext(PanelDataContext)
  if (!ctx) throw new Error('usePanelData must be used inside <PanelDataProvider> (VoiceRoom)')
  return ctx
}

/** For components that may render outside VoiceRoom (e.g. a chat card). */
export function useOptionalPanelData(): PanelData | null {
  return useContext(PanelDataContext)
}

function readStoredPanelState(): PanelState {
  if (typeof window === 'undefined') return { ...DEFAULT_PANEL_STATE }
  try { return parsePanelState(localStorage.getItem(PANEL_STORAGE_KEY)) } catch { return { ...DEFAULT_PANEL_STATE } }
}

/** Panel open/tab/width state, persisted across reloads. */
export function usePanelState() {
  const [state, setState] = useState<PanelState>(readStoredPanelState)
  useEffect(() => {
    try { localStorage.setItem(PANEL_STORAGE_KEY, serializePanelState(state)) } catch { /* quota / private mode */ }
  }, [state])
  const openPanel = useCallback((tab?: string) => setState((s) => ({ ...s, open: true, tab: tab || s.tab })), [])
  const closePanel = useCallback(() => setState((s) => (s.open ? { ...s, open: false } : s)), [])
  const togglePanel = useCallback((tab?: string) => setState((s) => {
    if (!s.open) return { ...s, open: true, tab: tab || s.tab }
    if (tab && tab !== s.tab) return { ...s, tab }
    return { ...s, open: false }
  }), [])
  const setTab = useCallback((tab: string) => setState((s) => (s.tab === tab ? s : { ...s, tab })), [])
  const setWidthPct = useCallback((pct: number) => setState((s) => {
    const w = clampPanelWidth(pct)
    return w === s.widthPct ? s : { ...s, widthPct: w }
  }), [])
  return useMemo(
    () => ({ ...state, openPanel, closePanel, togglePanel, setTab, setWidthPct }),
    [state, openPanel, closePanel, togglePanel, setTab, setWidthPct],
  )
}
