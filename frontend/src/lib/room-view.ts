// Read-only room view (#383): what the /view page shows of a live session.
// The agent's /view-token returns a status snapshot (and, unless ?status=1, a
// hidden subscribe-only LiveKit token); the page folds the room's broadcast
// stream into transcript and tool rows with applyViewEvent. Nothing here
// sends anything to the agent.

import { completeToolRow, toolMetaFromEvent, toolTarget, type ChatMessage } from '../components/voice/shared'
import { historyTurns } from './control-text'

export interface ViewTask { taskId: string; subagentType?: string; description?: string; status: string; startedAt?: number }

export interface RoomViewStatus {
  live: boolean
  room?: string
  sessionId?: string | null
  /** When the agent joined the room (ms). */
  since?: number | null
  phoneCall?: boolean
  busy?: { turnInFlight?: boolean; compacting?: boolean; permissionPending?: boolean }
  tasks?: ViewTask[]
  token?: string
  url?: string
}

/** Most rows the view keeps; older ones scroll away. */
export const VIEW_ROW_CAP = 300

const row = (role: ChatMessage['role'], content: string, now: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `view-${now}-${Math.random().toString(36).slice(2, 8)}`, role, content, timestamp: new Date(now), ...extra,
})

const cap = (rows: ChatMessage[]) => (rows.length > VIEW_ROW_CAP ? rows.slice(rows.length - VIEW_ROW_CAP) : rows)

/** One broadcast message from the room → the view's rows. Unknown types leave them unchanged. */
export function applyViewEvent(rows: ChatMessage[], data: any, now = Date.now()): ChatMessage[] {
  if (!data || typeof data.type !== 'string') return rows
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  switch (data.type) {
    case 'user_transcript':
      return text ? cap([...rows, row('user', text, now)]) : rows
    case 'assistant_response': {
      if (!text) return rows
      if (data.messageId && rows.some((r) => r.messageId === data.messageId)) return rows
      return cap([...rows, row('assistant', text, now, { messageId: data.messageId || undefined })])
    }
    case 'system':
      return text ? cap([...rows, row('system', text, now, { category: 'log' })]) : rows
    case 'tool_use': {
      if (typeof data.tool !== 'string' || !data.tool) return rows
      const meta = toolMetaFromEvent(data)
      if (meta.status === 'completed') {
        const done = completeToolRow(rows, meta)
        if (done) return done
      }
      return cap([...rows, row('system', toolTarget(meta) || meta.description || meta.tool, now, { category: 'log', toolName: meta.tool, toolMeta: meta })])
    }
    default:
      return rows
  }
}

/** Stored history (/session-messages) → rows, control notices dropped. */
export function historyMessages(msgs: Array<{ role: string; content: string; ts?: string | number | null }>): ChatMessage[] {
  return historyTurns(msgs).map((m, i) => ({ id: `hist-${i}`, role: m.role, content: m.content, timestamp: new Date(m.t) }))
}

/** Elapsed time for the running list: 45s, 3m 05s, 1h 02m. */
export function runTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** The live status line: what the session is doing besides its tasks. */
export function busyLabel(busy: RoomViewStatus['busy']): string | null {
  if (busy?.permissionPending) return 'Waiting for an approval in the session'
  if (busy?.compacting) return 'Compacting its memory'
  if (busy?.turnInFlight) return 'Working on a reply'
  return null
}
