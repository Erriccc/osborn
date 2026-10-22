const ROLES = [
  {
    name: 'Researcher',
    model: 'Sonnet',
    desc: 'Reads your codebase, docs, and the web to gather context before a line is written.',
  },
  {
    name: 'Reasoner',
    model: 'Opus',
    desc: 'Plans architecture and works through the hard trade-offs.',
  },
  {
    name: 'Writer',
    model: 'Opus',
    desc: 'Produces the actual code changes, held to your conventions.',
  },
  {
    name: 'Planner',
    model: 'Sonnet',
    desc: 'Breaks the goal into an ordered, trackable plan.',
  },
  {
    name: 'Tester',
    model: 'Sonnet',
    desc: 'Runs and writes tests, reports what passed and what broke.',
  },
  {
    name: 'Reviewer',
    model: 'Sonnet',
    desc: 'Reviews the diff for bugs and reuse before it reaches you.',
  },
]

export default function SubAgentTeam() {
  return (
    <section aria-labelledby="team-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
        <div className="max-w-[46rem]">
          <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
            The team
          </span>
          <h2
            id="team-heading"
            className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.02em] font-semibold"
          >
            One voice. A whole engineering team behind it.
          </h2>
        </div>

        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {ROLES.map((r) => (
            <div
              key={r.name}
              className="rounded-2xl border border-[var(--border)] p-5 flex flex-col"
              style={{ background: 'var(--surface)' }}
            >
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-[14px] text-[var(--text-primary)]">
                  {r.name}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--accent)] border border-[var(--border)] rounded-full px-2 py-[2px]">
                  {r.model}
                </span>
              </div>
              <p className="mt-3 text-[var(--text-secondary)] text-[14px] leading-[1.6]">
                {r.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
