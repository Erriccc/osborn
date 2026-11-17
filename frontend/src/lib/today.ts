// The dashboard's Today list: sessions, notes and finished briefs as ONE list,
// newest first, grouped by day (Things 3 "Today" / Linear "My Issues"). Each
// session appears once; callers pass the deduped list (prepareSessions).

import { prettySessionPreview, sessionActivityTime } from './sessions'
import type { SessionListItem } from './session-list'
import { PLATFORM_LABELS } from './content-refine'
import { toMs } from './outputs-model'

export type TodayKind = 'session' | 'note' | 'brief'

export interface TodayRow {
  kind: TodayKind
  /** Unique across kinds: `<kind>:<id>`. */
  key: string
  id: string
  at: string
  title: string
  /** Small label beside the title: session kind, brief type. */
  label?: string
  cwd?: string
  attachments?: string[]
}

export interface TodayNote { id: string; text: string; created_at: string; attachments?: string[] }
export interface TodayBrief { id: string; type: string | null; title: string | null; created_at: string }

const BRIEF_LABEL: Record<string, string> = { ...PLATFORM_LABELS, note: 'Note', source: 'Session brief', text_post: 'Post' }

export function buildTodayRows(sessions: SessionListItem[], notes: TodayNote[], briefs: TodayBrief[]): TodayRow[] {
  const rows: TodayRow[] = [
    ...sessions.map((s): TodayRow => {
      const pv = prettySessionPreview(s)
      return { kind: 'session', key: `session:${s.sessionId}`, id: s.sessionId, at: sessionActivityTime(s), title: pv.text, label: pv.kind === 'chat' ? undefined : pv.label, cwd: s.cwd }
    }),
    ...notes.map((n): TodayRow => ({ kind: 'note', key: `note:${n.id}`, id: n.id, at: n.created_at, title: n.text, attachments: n.attachments || [] })),
    ...briefs.map((b): TodayRow => ({ kind: 'brief', key: `brief:${b.id}`, id: b.id, at: b.created_at, title: b.title || 'Untitled brief', label: (b.type && (BRIEF_LABEL[b.type] || b.type)) || 'Brief' })),
  ]
  return rows.sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0))
}
