/**
 * /compare — feature comparison of Voice Native vs. other AI coding/agent tools.
 *
 * Server-rendered (static). SEO: title/description/OG/canonical. Positions by
 * difference (voice-native, runs-on-your-machine, multi-agent team, persistent
 * memory, meeting-aware, BYO-keys) without misrepresenting competitors.
 */
import type { Metadata } from 'next'
import MarketingShell from '@/components/marketing/MarketingShell'
import ComparisonMatrix from '@/components/marketing/ComparisonMatrix'
import MarketingCTA from '@/components/marketing/MarketingCTA'

const SITE_URL = 'https://www.voice-native.com'
const CANONICAL = `${SITE_URL}/compare`

const TITLE = 'Voice Native vs. Cursor, Copilot, Devin, Claude Code & Replit'
const DESCRIPTION =
  'A fair, feature-by-feature comparison of Voice Native against the main AI coding agents. Voice-native, runs on your own machine, a team of Claude sub-agents, persistent memory, meeting-aware, your keys.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    type: 'website',
    url: CANONICAL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'Voice Native',
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

const APPROACHES = [
  {
    kicker: 'The talk-to-it model',
    heading: 'Voice Native',
    body: 'You describe what you want out loud. A team of Claude sub-agents — Researcher, Reasoner, Writer, Tester, Planner, Reviewer — runs on your own machine, with persistent memory of your project and every move watchable live. It can even join a Zoom or Meet and turn a decision into work.',
    accent: true,
  },
  {
    kicker: 'The editor model',
    heading: 'Cursor · GitHub Copilot',
    body: 'AI woven into a local code editor: autocomplete, inline edits, codebase-aware chat, and an agent mode that plans and edits across files. Fast and familiar if your whole day lives in the IDE — and you are the one typing.',
  },
  {
    kicker: 'The delegate-a-task model',
    heading: 'Devin · Replit Agent',
    body: 'Hand off a task and an autonomous agent builds it in a cloud sandbox — environment, code, tests, deploy. Powerful for fire-and-forget work, with the trade-off that the code runs on their infrastructure, not yours.',
  },
  {
    kicker: 'The terminal model',
    heading: 'Claude Code',
    body: 'An agent that lives in your terminal: reads the repo, edits files, runs commands, works with Git — locally, through text. Excellent engine; Voice Native is built on this family of models, with voice, a multi-agent team, and meeting-awareness layered on top.',
  },
]

export default function ComparePage() {
  return (
    <MarketingShell>
      {/* Hero */}
      <section aria-labelledby="compare-hero" className="border-b border-[var(--border-subtle)]">
        <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)] md:text-[12px]">
            Compare
          </span>
          <h1
            id="compare-hero"
            className="font-display mt-4 max-w-[20ch] text-[clamp(2.25rem,6vw,4rem)] font-semibold leading-[1.02] tracking-[-0.02em] text-[var(--text-primary)]"
          >
            How Voice Native compares to other AI coding tools
          </h1>
          <p className="mt-6 max-w-[46rem] text-[17px] leading-relaxed text-[var(--text-secondary)] md:text-[19px]">
            Most AI coding tools hand you text to paste, or run the work on their
            servers. Voice Native is the one you talk to — a team of agents on your own
            machine, under your voice, in the open. Here is an honest look at where it
            fits next to the tools you already know.
          </p>
        </div>
      </section>

      {/* Four approaches */}
      <section aria-labelledby="approaches-heading">
        <div className="mx-auto max-w-[1200px] px-6 py-16 md:py-24">
          <h2
            id="approaches-heading"
            className="font-display max-w-[40rem] text-[clamp(1.75rem,4vw,2.75rem)] font-semibold leading-[1.05] tracking-[-0.02em] text-[var(--text-primary)]"
          >
            Four ways to let AI write your code
          </h2>
          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {APPROACHES.map((a) => (
              <div
                key={a.heading}
                className="rounded-2xl border p-6"
                style={{
                  background: a.accent ? 'var(--surface-raised)' : 'var(--surface)',
                  borderColor: a.accent ? 'var(--accent)' : 'var(--border)',
                }}
              >
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--accent)]">
                  {a.kicker}
                </span>
                <h3 className="font-display mt-3 text-[20px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
                  {a.heading}
                </h3>
                <p className="mt-3 text-[15px] leading-[1.65] text-[var(--text-secondary)]">
                  {a.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ComparisonMatrix />

      <MarketingCTA
        heading="See the difference by talking to it"
        body="The fastest way to understand a voice-native agent is to use your voice. Bring your own keys and run it on your own machine."
      />
    </MarketingShell>
  )
}
