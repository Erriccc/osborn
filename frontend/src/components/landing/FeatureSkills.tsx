const SKILLS = [
  'browser',
  'pdf',
  'slack',
  'youtube-transcript',
  'meeting-bot',
  'deep-research',
  '+more',
]

export default function FeatureSkills() {
  return (
    <section aria-labelledby="skills-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-24 border-t border-[var(--border-subtle)]">
        <div className="grid md:grid-cols-2 gap-10 md:gap-16 items-center">
          {/* Skill chips (first on desktop) */}
          <div className="order-2 md:order-1 flex flex-wrap gap-2.5" aria-hidden="true">
            {SKILLS.map((s) => (
              <span
                key={s}
                className="font-mono text-[12px] rounded-lg border border-[var(--border)] px-3 py-1.5"
                style={{
                  background: s === '+more' ? 'transparent' : 'var(--surface)',
                  color: s === '+more' ? 'var(--text-muted)' : 'var(--text-secondary)',
                }}
              >
                {s}
              </span>
            ))}
          </div>

          <div className="order-1 md:order-2">
            <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Skills
            </span>
            <h2
              id="skills-heading"
              className="font-display mt-4 text-[var(--text-primary)] text-[clamp(1.75rem,4vw,2.6rem)] leading-[1.08] tracking-[-0.02em] font-semibold"
            >
              Give it new abilities in one line.
            </h2>
            <p className="mt-5 max-w-[34rem] text-[var(--text-secondary)] text-[16px] leading-[1.65]">
              Skills extend Osborn beyond code. Install what you need and it just picks them
              up — browser automation, PDF parsing, Slack, YouTube transcripts, meeting bots,
              and more.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
