/**
 * long-work.ts — the running-time check for local writer work (#651).
 *
 * The voice session is for understanding; a writer task that runs past LONG_WRITER_MS is flagged to the main
 * agent on its next turn so it can hand the rest to a GitHub issue (the cloud issue agent picks it up) and say
 * where the task left off. Pure: `getRunningTasks()` rows in, one note out. The routing rule itself is the
 * ROUTING block in prompts/main-agent-budget.md.
 */
export const LONG_WRITER_MS = 5 * 60 * 1000

interface TaskRow { taskId: string; subagentType?: string; description?: string; startedAt: number }

/** Writer tasks running longer than `limitMs`, oldest first. */
export function overdueWriters(tasks: TaskRow[], now: number, limitMs = LONG_WRITER_MS): TaskRow[] {
  return tasks
    .filter((t) => t.subagentType === 'writer' && now - t.startedAt > limitMs)
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** The note for the next turn, or null. Task text is quoted data, short, on one line. */
export function overdueWriterNote(tasks: TaskRow[], now: number, limitMs = LONG_WRITER_MS): string | null {
  const late = overdueWriters(tasks, now, limitMs)
  if (!late.length) return null
  const lines = late.slice(0, 3).map((t) => {
    const mins = Math.floor((now - t.startedAt) / 60000)
    const what = String(t.description || 'writer task').replace(/\s+/g, ' ').trim().slice(0, 120)
    return `  · ${mins} min: "${what}"`
  })
  return [
    '[LONG LOCAL WRITE: a writer task has run past 5 minutes. This is a system note, not the user speaking.]',
    ...lines,
    'Per ROUTING: do not keep the user waiting. Ask the writer (SendMessage) where it has got to, then offer to file the rest as a GitHub issue for the cloud issue agent, with "Left off at:" in the body, and tell the user the issue number. Say it once.',
  ].join('\n')
}
