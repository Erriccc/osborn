/**
 * Feature-comparison matrix: Voice Native vs. the main AI coding/agent tools.
 *
 * Fair by construction — competitor cells say what each tool genuinely is, not
 * a strawman. Positioning is by difference, not disparagement. Server component.
 *
 * Responsive strategy: a real <table> on md+ (scrollable if needed), and a
 * stacked per-tool card layout on small screens driven by the same data.
 */

type Support = 'yes' | 'no' | 'partial'

interface Cell {
  support: Support
  note: string
}

interface Row {
  feature: string
  /** Column order: voiceNative, cursor, copilot, devin, claudeCode, replit */
  cells: [Cell, Cell, Cell, Cell, Cell, Cell]
}

const TOOLS = [
  'Voice Native',
  'Cursor',
  'GitHub Copilot',
  'Devin',
  'Claude Code',
  'Replit Agent',
] as const

const ROWS: Row[] = [
  {
    feature: 'Voice-native interface',
    cells: [
      { support: 'yes', note: 'You talk to it; voice is the primary interface' },
      { support: 'no', note: 'Editor + chat / prompt box' },
      { support: 'no', note: 'IDE chat + inline edits' },
      { support: 'no', note: 'Text tasks via UI, Slack, Jira' },
      { support: 'no', note: 'Terminal / text prompts' },
      { support: 'no', note: 'Chat prompts in the browser IDE' },
    ],
  },
  {
    feature: 'Runs on your own machine',
    cells: [
      { support: 'yes', note: 'Reads, writes, runs where your code already lives' },
      { support: 'yes', note: 'Local desktop editor (VS Code fork)' },
      { support: 'partial', note: 'Local IDE; agent context processed via service' },
      { support: 'no', note: 'Runs in Cognition’s cloud sandbox' },
      { support: 'yes', note: 'Runs locally in your terminal / IDE' },
      { support: 'no', note: 'Runs entirely in Replit’s cloud' },
    ],
  },
  {
    feature: 'Multi-agent specialist team',
    cells: [
      { support: 'yes', note: 'Researcher / Reasoner / Writer / Tester / Planner / Reviewer' },
      { support: 'partial', note: 'Single agent; parallel agents in some flows' },
      { support: 'partial', note: 'Agent mode; plugins extend it' },
      { support: 'partial', note: 'Autonomous agent; can run parallel sessions' },
      { support: 'partial', note: 'Supports parallel sub-agents' },
      { support: 'no', note: 'Single build-and-deploy agent' },
    ],
  },
  {
    feature: 'Persistent project memory',
    cells: [
      { support: 'yes', note: 'Per-session semantic memory of your project' },
      { support: 'partial', note: 'Codebase indexing per session' },
      { support: 'partial', note: 'Repo + session context' },
      { support: 'partial', note: 'Knowledge base learns repo conventions' },
      { support: 'partial', note: 'Project files + context window' },
      { support: 'partial', note: 'Project context within the workspace' },
    ],
  },
  {
    feature: 'Meeting-aware (joins Zoom / Meet)',
    cells: [
      { support: 'yes', note: 'Joins a call as a bot; decisions → work' },
      { support: 'no', note: 'Not a meeting participant' },
      { support: 'no', note: 'Not a meeting participant' },
      { support: 'no', note: 'Task-driven, not in-meeting' },
      { support: 'no', note: 'Not a meeting participant' },
      { support: 'no', note: 'Not a meeting participant' },
    ],
  },
  {
    feature: 'Bring your own keys / no lock-in',
    cells: [
      { support: 'yes', note: 'Your Anthropic / OpenRouter / Fireworks / Recall keys' },
      { support: 'partial', note: 'API-key option on some plans; hosted default' },
      { support: 'no', note: 'Subscription; models via GitHub' },
      { support: 'no', note: 'Subscription to Cognition’s platform' },
      { support: 'partial', note: 'Anthropic subscription or API key' },
      { support: 'no', note: 'Subscription to Replit’s platform' },
    ],
  },
  {
    feature: 'Live, watchable agent activity',
    cells: [
      { support: 'yes', note: 'Every sub-agent, tool call, and process, live' },
      { support: 'partial', note: 'Diffs + agent steps in-editor' },
      { support: 'partial', note: 'Proposed diffs + terminal output' },
      { support: 'partial', note: 'Session replay of the run' },
      { support: 'partial', note: 'Streamed tool calls in the terminal' },
      { support: 'partial', note: 'Progress + preview in the IDE' },
    ],
  },
]

const SYMBOL: Record<Support, { glyph: string; label: string; color: string }> = {
  yes: { glyph: '●', label: 'Yes', color: 'var(--accent)' },
  partial: { glyph: '◐', label: 'Partial', color: 'var(--text-secondary)' },
  no: { glyph: '○', label: 'No', color: 'var(--text-muted)' },
}

function SupportMark({ cell }: { cell: Cell }) {
  const s = SYMBOL[cell.support]
  return (
    <span className="inline-flex items-baseline gap-2">
      <span aria-hidden="true" style={{ color: s.color }} className="text-[15px] leading-none">
        {s.glyph}
      </span>
      <span className="sr-only">{s.label}. </span>
      <span className="text-[13px] leading-snug text-[var(--text-secondary)]">{cell.note}</span>
    </span>
  )
}

export default function ComparisonMatrix() {
  return (
    <section aria-labelledby="matrix-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-16 md:py-24">
        <div className="max-w-[46rem]">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)] md:text-[12px]">
            Feature comparison
          </span>
          <h2
            id="matrix-heading"
            className="font-display mt-4 text-[clamp(1.75rem,4vw,2.75rem)] font-semibold leading-[1.05] tracking-[-0.02em] text-[var(--text-primary)]"
          >
            Where Voice Native is actually different
          </h2>
          <p className="mt-4 text-[16px] leading-relaxed text-[var(--text-secondary)]">
            Every tool here is good at what it does. This table is about fit, not
            winners — it maps each tool honestly against the things Voice Native was
            built around.
          </p>
        </div>

        {/* Legend */}
        <ul className="mt-8 flex flex-wrap gap-5 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {(['yes', 'partial', 'no'] as Support[]).map((k) => (
            <li key={k} className="inline-flex items-center gap-2">
              <span aria-hidden="true" style={{ color: SYMBOL[k].color }}>
                {SYMBOL[k].glyph}
              </span>
              {SYMBOL[k].label}
            </li>
          ))}
        </ul>

        {/* Table: md and up */}
        <div className="mt-10 hidden overflow-x-auto md:block">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              Feature comparison of Voice Native against Cursor, GitHub Copilot,
              Devin, Claude Code, and Replit Agent.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="w-[18%] p-4 align-bottom">
                  <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                    Capability
                  </span>
                </th>
                {TOOLS.map((t, i) => (
                  <th
                    key={t}
                    scope="col"
                    className="p-4 align-bottom font-display text-[15px] font-semibold"
                    style={{ color: i === 0 ? 'var(--accent)' : 'var(--text-primary)' }}
                  >
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.feature} className="border-t border-[var(--border-subtle)]">
                  <th
                    scope="row"
                    className="p-4 align-top font-display text-[15px] font-semibold text-[var(--text-primary)]"
                  >
                    {row.feature}
                  </th>
                  {row.cells.map((cell, i) => (
                    <td
                      key={i}
                      className="p-4 align-top"
                      style={i === 0 ? { background: 'var(--accent-glow)' } : undefined}
                    >
                      <SupportMark cell={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Stacked cards: small screens */}
        <div className="mt-10 space-y-5 md:hidden">
          {TOOLS.map((tool, colIdx) => (
            <div
              key={tool}
              className="rounded-2xl border border-[var(--border)] p-5"
              style={{
                background: colIdx === 0 ? 'var(--surface-raised)' : 'var(--surface)',
              }}
            >
              <h3
                className="font-display text-[18px] font-semibold"
                style={{ color: colIdx === 0 ? 'var(--accent)' : 'var(--text-primary)' }}
              >
                {tool}
              </h3>
              <dl className="mt-4 space-y-3">
                {ROWS.map((row) => (
                  <div key={row.feature}>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                      {row.feature}
                    </dt>
                    <dd className="mt-1">
                      <SupportMark cell={row.cells[colIdx]} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>

        <p className="mt-8 font-mono text-[12px] leading-relaxed tracking-[0.02em] text-[var(--text-muted)]">
          Competitor details reflect each product’s publicly described capabilities as
          of October 2026 and are summarized in good faith; vendors ship fast, so check
          their docs for the current state.
        </p>
      </div>
    </section>
  )
}
