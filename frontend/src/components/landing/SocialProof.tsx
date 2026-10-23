const DIFFERENTIATORS = [
  {
    title: 'The one you talk to',
    body: 'Not another prompt box. Describe what you want out loud, the way you would to a teammate — no prompt engineering, no copy-paste.',
    path: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4',
  },
  {
    title: 'Runs on your machine',
    body: 'Your code is read, written, and executed where it already lives. It is never uploaded to or stored on our servers — the reason security teams actually sign off.',
    path: 'M4 5h16a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM8 20h8M12 16v4',
  },
  {
    title: 'A team, not a chatbot',
    body: 'It dispatches specialists — Opus for the hard reasoning and writing, Sonnet for fast research, testing, and review — instead of cramming everything into one overloaded context.',
    path: 'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6-4a3 3 0 11-3-3',
  },
  {
    title: 'It remembers your project',
    body: 'Per-session semantic memory — your decisions, your codebase shape, last week’s bug. Pick up where you left off instead of re-explaining your stack every time.',
    path: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  {
    title: 'Watch every move, live',
    body: 'No black box. Every running sub-agent, every tool call, your machine’s RAM and processes, the editor updating in real time — and you can cut in by voice at any moment.',
    path: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z',
  },
  {
    title: 'Your keys. No lock-in.',
    body: 'Bring your own Anthropic, OpenRouter, Fireworks, or Recall keys. Self-host or run it on your own cloud. No lock-in at the model, compute, or data layer.',
    path: 'M15 7a2 2 0 012 2m4-2a6 6 0 01-7.74 5.74L10 17l-2 2-2-2 2-2m6.26-6.74A6 6 0 1115 7z',
  },
]

export default function SocialProof() {
  return (
    <section aria-labelledby="why-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
        <div className="max-w-[46rem]">
          <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Why it&rsquo;s different
          </span>
          <h2
            id="why-heading"
            className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.02em] font-semibold"
          >
            Not a faster chatbot. A different way to ship.
          </h2>
          <p className="mt-4 text-[var(--text-secondary)] text-[16px] md:text-[17px] leading-relaxed">
            Most AI coding tools hand you text to paste and run on their servers. Voice Native runs a team of agents on your machine, under your voice, in the open.
          </p>
        </div>

        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {DIFFERENTIATORS.map((d, i) => (
            <div
              key={i}
              className="rounded-2xl border border-[var(--border)] p-6 flex flex-col"
              style={{ background: 'var(--surface)' }}
            >
              <span
                className="w-9 h-9 rounded-xl flex items-center justify-center mb-4"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                aria-hidden="true"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d={d.path} />
                </svg>
              </span>
              <h3 className="font-display text-[var(--text-primary)] text-[19px] leading-snug font-semibold">
                {d.title}
              </h3>
              <p className="mt-2 text-[var(--text-secondary)] text-[14px] leading-relaxed">
                {d.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
