const TESTIMONIALS = [
  {
    quote:
      'I described the feature out loud on my commute and the PR was waiting when I sat down.',
    name: '[Name]',
    role: '[Role], [Company]',
  },
  {
    quote:
      'Watching the sub-agents work is the first time an AI tool has actually felt like a team.',
    name: '[Name]',
    role: '[Role], [Company]',
  },
  {
    quote:
      'It runs on our own box with our own keys. That is the only reason we were allowed to adopt it.',
    name: '[Name]',
    role: '[Role], [Company]',
  },
]

export default function SocialProof() {
  return (
    <section aria-labelledby="social-proof-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
        <div className="max-w-[40rem]">
          <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Who it&rsquo;s for
          </span>
          <h2
            id="social-proof-heading"
            className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.02em] font-semibold"
          >
            Built for people who ship.
          </h2>
        </div>

        <div className="mt-14 grid md:grid-cols-3 gap-5">
          {TESTIMONIALS.map((t, i) => (
            <figure
              key={i}
              className="rounded-2xl border border-[var(--border)] p-6 flex flex-col"
              style={{ background: 'var(--surface)' }}
            >
              <blockquote className="font-display text-[var(--text-primary)] text-[18px] leading-[1.5] italic">
                &ldquo;{t.quote}&rdquo;
              </blockquote>
              <figcaption className="mt-5 flex items-center gap-3">
                <span
                  className="w-8 h-8 rounded-full flex-shrink-0"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                  aria-hidden="true"
                />
                <span className="flex flex-col">
                  <span className="font-mono text-[12px] text-[var(--text-primary)]">
                    {t.name}
                  </span>
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    {t.role}
                  </span>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}
