// activityCategory — categorisation helpers for the Activity log drawer (#86).
//
// The drawer jams three unrelated content kinds into one strip:
//   • commands/tool calls the agent ran (Log tab),
//   • sub-agent results (Running tab),
//   • host/machine telemetry (Machine tab).
// Within the Log tab every row looked identical regardless of whether it was a
// shell command, a file edit, a search or a web fetch. These pure helpers
// classify a tool-call row from the ONE field already present on it — the tool
// name — so the UI can label and format each row by what it actually is.
//
// Pure + dependency-free so it can be unit-tested with plain tsx (see
// activityCategory.test.ts) and reused anywhere without pulling in React.

// A coarse, user-facing grouping of the tool that produced a Log row.
//   command — a shell command the agent ran (Bash)
//   file    — a file was read, written or edited
//   search  — a codebase search (grep/glob)
//   web     — the agent fetched or searched the web
//   note    — a plain log line / anything without a recognised tool
export type ActivityCategory = 'command' | 'file' | 'search' | 'web' | 'note'

// Classify a row from its tool name. Case-insensitive; tolerant of an
// undefined/blank tool (falls back to 'note') so a malformed event never throws.
export function categorizeTool(tool: string | undefined | null): ActivityCategory {
  const t = (tool ?? '').trim().toLowerCase()
  if (!t) return 'note'
  if (t === 'bash') return 'command'
  if (
    t === 'read' ||
    t === 'write' ||
    t === 'edit' ||
    t === 'multiedit' ||
    t === 'notebookread' ||
    t === 'notebookedit'
  ) return 'file'
  if (t === 'grep' || t === 'glob') return 'search'
  if (t === 'webfetch' || t === 'websearch') return 'web'
  return 'note'
}

// Per-category presentation: a short human label plus muted Tailwind classes for
// a quiet classifier chip (a per-category accent on a neutral ground — a label,
// not a loud badge). Styling lives beside the categoriser so a new category can
// never render unstyled.
export interface CategoryStyle {
  label: string      // short human label shown on the chip
  chipClass: string  // chip text + border + background
  dotClass: string   // the leading accent dot
}

const CATEGORY_STYLE: Record<ActivityCategory, CategoryStyle> = {
  command: { label: 'Command', chipClass: 'text-slate-300 bg-slate-700/40 border-slate-600/40', dotClass: 'bg-slate-400' },
  file:    { label: 'File',    chipClass: 'text-blue-300 bg-blue-500/10 border-blue-500/25',    dotClass: 'bg-blue-400' },
  search:  { label: 'Search',  chipClass: 'text-violet-300 bg-violet-500/10 border-violet-500/25', dotClass: 'bg-violet-400' },
  web:     { label: 'Web',     chipClass: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/25',    dotClass: 'bg-cyan-400' },
  note:    { label: 'Note',    chipClass: 'text-gray-400 bg-gray-600/20 border-gray-600/30',    dotClass: 'bg-gray-500' },
}

export function categoryStyle(cat: ActivityCategory): CategoryStyle {
  return CATEGORY_STYLE[cat]
}

// Clean an agent's result/verdict text for display in the Running tab.
//
// Sub-agent results arrive with raw markdown that renders as literal noise in a
// plain-text row — `**GATE: PASS**`, `__done__`, inline `code`, leading `#`
// headers, bullet dashes. We are not rendering a markdown document here (that
// would be disproportionate for a one-to-few-line result line), so instead we
// strip the emphasis/structure markers and leave clean, readable prose. Idempotent
// and whitespace-collapsing so an expanded result reads as a sentence, not source.
export function stripResultMarkdown(s: string | undefined | null): string {
  if (!s) return ''
  return s
    // bold / italic emphasis: **x** __x__ *x* _x_  → x
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![A-Za-z0-9])[*_](?=\S)(.+?)(?<=\S)[*_](?![A-Za-z0-9])/g, '$1')
    // inline code: `x` → x
    .replace(/`([^`]+)`/g, '$1')
    // leading markdown header hashes and blockquote markers on each line
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    // leading bullet / list markers
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    // collapse runs of blank lines, trim trailing spaces per line
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
