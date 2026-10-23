import Orb from './Orb'
import ScrollAssemblyFallback from './ScrollAssemblyFallback'

/**
 * ScrollAssembly — the cinematic centerpiece. As you scroll, the parts of the
 * "business OS" piece themselves together, Apple-keynote style:
 *
 *   voice  →  sub-agent team  →  your machine  →  live activity  →  shipped output
 *
 * Layout: a `position: sticky` left rail pins the orb + running narration while
 * the right column scrolls; each part (marked [data-vn2-part]) assembles as it
 * enters the viewport.
 *
 * Motion is CSS-only (V2Styles): native animation-timeline where supported,
 * IntersectionObserver fallback otherwise, static assembled state under
 * prefers-reduced-motion. This file is a server component; the only client code
 * is the tiny dormant ScrollAssemblyFallback island.
 */

type Part = {
  step: string
  dir?: 'left' | 'right' | 'pop'
  render: React.ReactNode
}

function Panel({
  kicker,
  title,
  children,
}: {
  kicker: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className="rounded-2xl border border-[var(--border)] p-5 md:p-6"
      style={{ background: 'var(--surface)' }}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--accent)]">
        {kicker}
      </span>
      <h3 className="font-display mt-2 text-[var(--text-primary)] text-[20px] md:text-[22px] tracking-[-0.01em] font-semibold">
        {title}
      </h3>
      <div className="mt-4">{children}</div>
    </div>
  )
}

const PARTS: Part[] = [
  {
    step: '01 · voice',
    dir: 'right',
    render: (
      <Panel kicker="You say" title="“Add Stripe billing and ship it.”">
        <div className="flex items-center gap-3">
          <span
            className="inline-flex items-center gap-2 font-mono text-[12px] rounded-full border border-[var(--border)] px-3 py-1"
            style={{ color: 'var(--voice-listening)' }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--voice-listening)' }} />
            listening
          </span>
          <span className="font-mono text-[12px] text-[var(--text-muted)]">
            no prompt-wrangling · just talk
          </span>
        </div>
      </Panel>
    ),
  },
  {
    step: '02 · the team',
    dir: 'left',
    render: (
      <Panel kicker="It dispatches" title="A team spins up behind the wheel.">
        <ul className="flex flex-col gap-2 font-mono text-[12px]">
          {[
            { n: 'Researcher', m: 'sonnet', s: 'reading repo…', live: true },
            { n: 'Reasoner', m: 'opus', s: 'planning the migration…', live: true },
            { n: 'Writer', m: 'opus', s: 'queued', live: false },
            { n: 'Tester', m: 'sonnet', s: 'queued', live: false },
          ].map((a) => (
            <li key={a.n} className="flex items-center gap-2">
              <span style={{ color: a.live ? 'var(--voice-listening)' : 'var(--text-muted)' }}>
                {a.live ? '●' : '○'}
              </span>
              <span className="text-[var(--text-primary)]">{a.n}</span>
              <span className="px-1.5 py-[1px] rounded text-[10px] text-[var(--text-secondary)] border border-[var(--border)]">
                {a.m}
              </span>
              <span className="text-[var(--text-secondary)] truncate">{a.s}</span>
            </li>
          ))}
        </ul>
      </Panel>
    ),
  },
  {
    step: '03 · your machine',
    dir: 'right',
    render: (
      <Panel kicker="It works on" title="Your machine. Not our servers.">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 font-mono text-[11px] text-[var(--text-secondary)] rounded-full border border-[var(--border)] px-3 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--voice-speaking)]" />
            machine · 4.1 / 8 GB · 3 procs
          </span>
          <span className="inline-flex items-center gap-2 font-mono text-[11px] text-[var(--text-secondary)] rounded-full border border-[var(--border)] px-3 py-1">
            keys encrypted · never shown back
          </span>
        </div>
        <p className="mt-3 text-[var(--text-secondary)] text-[13px] leading-[1.6]">
          Code is read, written, and run where it already lives. Nothing is uploaded.
        </p>
      </Panel>
    ),
  },
  {
    step: '04 · live activity',
    dir: 'left',
    render: (
      <Panel kicker="You watch" title="Every move, in real time.">
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--background)] overflow-hidden">
          <div className="px-3 h-7 flex items-center border-b border-[var(--border-subtle)]">
            <span className="font-mono text-[10px] text-[var(--text-muted)]">src/billing/stripe.ts</span>
          </div>
          <pre className="font-mono text-[11px] leading-[1.7] px-3 py-2 overflow-hidden">
            <code>
              <span className="block text-[var(--text-muted)]">  export async function</span>
              <span
                className="block"
                style={{ background: 'color-mix(in srgb, var(--voice-speaking) 12%, transparent)', color: 'var(--voice-speaking)' }}
              >
                +   createCheckout(uid: string) {'{'}
              </span>
              <span
                className="block"
                style={{ background: 'color-mix(in srgb, var(--voice-speaking) 12%, transparent)', color: 'var(--voice-speaking)' }}
              >
                +     return stripe.checkout.sessions.create(…)
              </span>
              <span className="block text-[var(--text-muted)]">  {'}'}</span>
            </code>
          </pre>
        </div>
      </Panel>
    ),
  },
  {
    step: '05 · shipped',
    dir: 'pop',
    render: (
      <Panel kicker="It delivers" title="Shipped — while you stayed in your seat.">
        <div className="flex items-center gap-2 font-mono text-[12px]">
          <span style={{ color: 'var(--voice-speaking)' }}>✓</span>
          <span className="text-[var(--text-primary)]">tests passing · reviewed · committed</span>
        </div>
        <p className="mt-3 text-[var(--text-secondary)] text-[13px] leading-[1.6]">
          You spoke a goal. The OS drove the work from intent to shipped output —
          hands-free.
        </p>
      </Panel>
    ),
  },
]

export default function ScrollAssembly() {
  return (
    <section id="assemble" className="relative scroll-mt-16">
      {/* Dormant client island: IntersectionObserver fallback only (no DOM). */}
      <ScrollAssemblyFallback />

      <div className="mx-auto max-w-[1200px] px-6 py-24 md:py-32">
        <div className="max-w-[46rem] mb-16 md:mb-24">
          <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Watch it assemble
          </span>
          <h2 className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,5vw,3.2rem)] leading-[1.04] tracking-[-0.02em] font-semibold">
            One sentence in. A working business OS out.
          </h2>
          <p className="mt-5 max-w-[34rem] text-[var(--text-secondary)] text-[16px] leading-[1.65]">
            Scroll, and the parts piece together the way they do in a real session —
            voice, the agent team, your machine, live activity, shipped output.
          </p>
        </div>

        <div className="grid md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] gap-8 md:gap-16">
          {/* Sticky rail — the pinned "driver" presence */}
          <div className="hidden md:block">
            <div className="sticky top-[18vh] flex flex-col items-start">
              <Orb size={104} state="thinking" />
              <p className="mt-6 font-display text-[var(--text-primary)] text-[22px] leading-[1.2] tracking-[-0.01em]">
                You stay in the
                <br />
                conversation.
              </p>
              <p className="mt-3 font-mono text-[12px] text-[var(--text-muted)] leading-[1.6]">
                The system drives. You can
                <br />
                cut in by voice anytime.
              </p>
            </div>
          </div>

          {/* The assembling stack */}
          <ol className="relative flex flex-col gap-10 md:gap-16">
            {/* Spine the connectors draw along */}
            {PARTS.map((part, i) => (
              <li key={part.step} className="relative">
                {i > 0 && (
                  <span
                    data-vn2-part
                    className="vn2-connector absolute -top-10 md:-top-16 left-6 w-px h-10 md:h-16"
                    style={{ background: 'color-mix(in srgb, var(--accent) 40%, transparent)' }}
                    aria-hidden="true"
                  />
                )}
                <div className="flex items-center gap-3 mb-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
                    {part.step}
                  </span>
                </div>
                <div
                  data-vn2-part
                  className={`vn2-part vn2-d${(i % 3) + 1} ${
                    part.dir === 'left'
                      ? 'vn2-left'
                      : part.dir === 'right'
                        ? 'vn2-right'
                        : part.dir === 'pop'
                          ? 'vn2-pop'
                          : ''
                  }`}
                >
                  {part.render}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
