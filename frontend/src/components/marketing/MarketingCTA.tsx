import Link from 'next/link'

/**
 * Shared call-to-action band for marketing pages. Links to /login.
 * Server component, no client JS.
 */
export default function MarketingCTA({
  heading = 'Stop typing prompts. Start talking.',
  body = 'Describe what you want out loud. Voice Native runs a team of Claude sub-agents on your own machine — your code, your keys, in the open.',
}: {
  heading?: string
  body?: string
}) {
  return (
    <section aria-labelledby="cta-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
        <div
          className="rounded-3xl border border-[var(--border)] p-8 text-center md:p-14"
          style={{
            background:
              'radial-gradient(120% 140% at 50% 0%, var(--accent-glow), transparent 60%), var(--surface)',
          }}
        >
          <h2
            id="cta-heading"
            className="font-display mx-auto max-w-[32rem] text-[clamp(1.75rem,4vw,2.75rem)] font-semibold leading-[1.05] tracking-[-0.02em] text-[var(--text-primary)]"
          >
            {heading}
          </h2>
          <p className="mx-auto mt-5 max-w-[40rem] text-[16px] leading-relaxed text-[var(--text-secondary)] md:text-[17px]">
            {body}
          </p>
          <div className="mt-9">
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-full bg-[var(--accent)] px-7 py-3 font-mono text-[13px] font-medium uppercase tracking-[0.1em] text-[var(--background)] transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              Get started
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
