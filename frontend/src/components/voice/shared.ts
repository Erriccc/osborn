import { useEffect, useLayoutEffect, useRef } from 'react'
import { clampPopoverShift } from '@/lib/popover-clamp'

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

// ── Viewport clamp for anchored header popovers ───────────────────────────
// Width caps (max-w-[calc(100vw-…)]) alone don't stop a popover from opening
// off-screen: a right-anchored menu whose trigger wraps to the LEFT of the
// toolbar (iPad portrait) runs off the left edge. Attach the returned ref to
// the popover; while open it measures the natural box and applies a
// translateX that keeps it inside the viewport. Full-width mobile sheets
// (inset-x-0) measure as already fitting and are left untouched.
export function useViewportClamp<T extends HTMLElement = HTMLDivElement>(open: boolean, margin = 8) {
  const ref = useRef<T>(null)
  useIsoLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    if (!el) return
    // Clamp to the VISIBLE chat region, not just the window. With a side panel
    // (Outputs) or the Rooms rail open, the chat column is a narrow strip and a
    // right-anchored popover can clear the viewport yet still clip at the pane
    // edge (issue #85). The pane is the nearest ancestor that clips its overflow
    // (overflow-hidden), so measure that and clamp inside it. Found once per
    // open — the popover stays mounted in the same pane while it is open.
    let region: HTMLElement | null = null
    for (let node = el.parentElement; node; node = node.parentElement) {
      const ox = getComputedStyle(node).overflowX
      if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') { region = node; break }
    }
    const apply = () => {
      el.style.transform = ''
      const r = el.getBoundingClientRect()
      const vw = document.documentElement.clientWidth || window.innerWidth
      let regionLeft = 0
      let regionRight = vw
      if (region) {
        const rr = region.getBoundingClientRect()
        regionLeft = rr.left
        regionRight = rr.right
      }
      const dx = clampPopoverShift(r.left, r.width, vw, margin, regionLeft, regionRight)
      el.style.transform = dx ? `translateX(${dx}px)` : ''
    }
    apply()
    window.addEventListener('resize', apply)
    window.visualViewport?.addEventListener('resize', apply)
    // Re-measure when the popover's own box changes after opening (e.g. the
    // skills list loads and the popover grows past the edge) AND when the chat
    // pane resizes — opening or closing the Outputs panel / Rooms rail moves the
    // popover's anchor without resizing the popover itself (issue #85). translateX
    // does not change the observed layout size, so apply() can't feed back a loop.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => apply()) : null
    ro?.observe(el)
    if (region) ro?.observe(region)
    return () => {
      window.removeEventListener('resize', apply)
      window.visualViewport?.removeEventListener('resize', apply)
      ro?.disconnect()
      el.style.transform = ''
    }
  }, [open, margin])
  return ref
}

// ── Header-panel mutual exclusion ────────────────────────────────────────
// Each header dropdown (History, Agents, Skills, Instances, More, Meeting) owns
// its own open-state. Without coordination they STACK and overlap, and once
// stacked a backdrop sits over the triggers so re-click and Escape can't close
// them (recovery only by reload) — the overlay bug in the audit §13.3 and the
// user's screenshot. This tiny event bus makes them mutually exclusive: opening
// one announces itself and every other panel closes.
const HEADER_PANEL_EVT = 'vn:header-panel-open'
export function usePanelExclusive(id: string, open: boolean, setOpen: (v: boolean) => void) {
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent).detail !== id) setOpenRef.current(false)
    }
    window.addEventListener(HEADER_PANEL_EVT, onOther)
    return () => window.removeEventListener(HEADER_PANEL_EVT, onOther)
  }, [id])
  useEffect(() => {
    if (open) { try { window.dispatchEvent(new CustomEvent(HEADER_PANEL_EVT, { detail: id })) } catch { /* no-op */ } }
  }, [open, id])
}

// ---------------------------------------------------------------------------
// Time-awareness helpers (no imports needed — pure Date math)
// ---------------------------------------------------------------------------

/** Returns a compact local-time tag to prepend to outgoing agent messages.
 *  e.g. "[time: 2026-08-18 14:32 local] "
 *  Visible to the agent only — never shown in the user's chat bubble.
 */
export function addTimeTag(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  return `[time: ${yyyy}-${mm}-${dd} ${hh}:${min} local] `
}

/** Formats an elapsed millisecond count into a human-readable string.
 *  e.g. 4.5h → "~4.5 hours", 30m → "~30 minutes"
 */
export function formatElapsed(ms: number): string {
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `~${mins} minute${mins !== 1 ? 's' : ''}`
  const hours = Math.round((ms / 3600000) * 10) / 10
  return `~${hours} hour${hours !== 1 ? 's' : ''}`
}

// Message parts inspired by AI SDK - supports streaming, tool calls, reasoning
export interface MessagePart {
  type: 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'code'
  content: string
  toolName?: string
  status?: 'pending' | 'running' | 'completed' | 'error'
  language?: string
}

// Structured detail for a tool call — powers the Claude-style Logs cards
// (Read/Edited/Ran with file name, +/- line counts, and an expandable diff).
// Every field is best-effort; a card with only `tool` degrades gracefully.
export interface ToolMeta {
  tool: string
  status?: 'running' | 'completed'
  filePath?: string
  fileName?: string
  command?: string
  pattern?: string
  url?: string
  description?: string
  linesAdded?: number
  linesRemoved?: number
  editCount?: number
  diff?: string
  agentRole?: string
}

// Payload for a persistent, expandable "Conversation compacted" transcript
// marker (phase 1 of compaction integrity / visible memory). Driven entirely by
// the already-flowing compaction_* data-channel events — it is pure surface and
// does NOT change what gets compacted or how. `skillNames` are the durable
// memories/skills the compaction wrote (what was kept); `skillsWritten` is their
// count (may be 0 — a compaction with no new memory is still worth marking).
export interface CompactionMarker {
  trigger?: string
  skillNames: string[]
  skillsWritten: number
  at: number
  // Set when the agent's append-only integrity self-check (compaction-log.ts)
  // detected that transcript content may have been dropped across this
  // compaction. Surfaced in the expanded marker card.
  integrityWarning?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  toolName?: string
  parts?: MessagePart[]
  isStreaming?: boolean
  category?: 'chat' | 'log'
  toolMeta?: ToolMeta
  // Present only on a compaction-marker row; renders CompactionMarkerCard in
  // place of a normal bubble (see MessageBubble).
  compaction?: CompactionMarker
  messageId?: string
  chunkIndex?: number
  liked?: boolean
  // Set on the in-chat card for a file the agent just wrote (renders FileCard).
  fileRef?: { filePath: string; fileName: string }
  // Id sent with a typed message (user_text) and echoed back on its
  // user_transcript, so the echo is deduped (bug d9bb78b2).
  clientMsgId?: string
}

export interface SpeakingChunk {
  messageId: string
  chunkIndex: number
}

// Session info from backend
export interface SessionInfo {
  sessionId: string
  timestamp: string
  lastMessage?: string
  messageCount: number
  // The session's on-disk cwd/project — REQUIRED to resume it as a background slot
  // (Claude --resume looks up by file location, so spawn must forward this as workingDir).
  cwd?: string
  projectPath?: string
  // Agent >= PR #18/#20: cleaned title and real last-turn time. Optional for
  // older agents; read through deriveSessionTitle(session) and
  // sessionActivityTime(session) from lib/sessions (bug c50200ef).
  title?: string | null
  firstTs?: string | null
  lastActivityAt?: string | null
}

// Slot info from background session system
export interface SlotInfo {
  id: string
  isFocused: boolean
  workingDir?: string
  hasSession: boolean
  status?: 'ready' | 'pending' | 'error'
  error?: string
}

// MCP server status from backend
export interface McpServerStatus {
  serverKey: string
  name: string
  description: string
  category: 'code' | 'web' | 'data' | 'utility'
  transport: 'stdio' | 'http' | 'sse'
  enabled: boolean
  available: boolean
  missingEnvVars?: string[]
  source: 'catalog' | 'config'
}

// Generated file tracking (plans + research artifacts)
export interface GeneratedFile {
  filePath: string
  fileName: string
  content?: string
  // Supabase Storage URL. When present, the agent uploaded this file to
  // Supabase rather than sending inline content — fetch from this URL to
  // render. Keeps the LiveKit data channel healthy for large artifacts
  // (resume PDFs, search indexes) that would otherwise corrupt the
  // publisher peer connection.
  url?: string
  type: 'plan' | 'diagram' | 'notes' | 'image' | 'summary' | 'html' | 'other'
  source: 'plan' | 'research'  // .claude/plans/ vs .osborn/sessions/
  updatedAt: Date
  isImage?: boolean
  mimeType?: string
  // Set when the agent had to fall back to inline delivery and truncated
  // the payload. Frontend can show a "truncated — N KB original" hint.
  truncated?: boolean
  originalSize?: number
  // Outputs drawer (L4): session whose workspace holds the file, when this
  // browser first saw it written, and an agent read error (replaces the old
  // literal "Empty file" body).
  sessionId?: string
  createdAt?: Date
  loadError?: string
}

/**
 * Strip internal recall provenance that the fast brain sometimes echoes into an
 * answer so it never clutters the chat bubble — e.g.
 *   [main L550 · tool_result · both] 2026-08-09T19:29:01.229Z
 * plus bare "L123: ..." prefixes and standalone ISO timestamps. Mirrors the
 * agent-side sanitizer (pipeline-fastbrain) so resumed/historical messages that
 * predate that fix also render clean.
 */
export function stripProvenance(text: string): string {
  if (!text || (!text.includes('·') && !/\bL\d+\b/.test(text))) return text
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (/^\[[^\]]*\bL\d+\b[^\]]*·[^\]]*\]/.test(t)) return false
      if (/^L\d+\s*:/.test(t)) return false
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(t)) return false
      // Transport/echo lines that leak raw into chat: tagged osborn echoes like
      // '[feat brazil (jstbae)] (osborn): ...' and '[Fast Brain] [123hz] [osborn]: ...'
      // (internal provenance the user must never see; observed on phone + desktop)
      if (/^\[[^\]]*\]\s*\(osborn\)\s*:/i.test(t)) return false
      if (/^\[Fast Brain\]/i.test(t)) return false
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
