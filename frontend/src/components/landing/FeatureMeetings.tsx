export default function FeatureMeetings() {
  return (
    <section aria-labelledby="meetings-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-24 border-t border-[var(--border-subtle)]">
        <div className="grid md:grid-cols-2 gap-10 md:gap-16 items-center">
          <div>
            <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Meetings
            </span>
            <h2
              id="meetings-heading"
              className="font-display mt-4 text-[var(--text-primary)] text-[clamp(1.75rem,4vw,2.6rem)] leading-[1.08] tracking-[-0.02em] font-semibold"
            >
              It can sit in your meetings.
            </h2>
            <p className="mt-5 max-w-[34rem] text-[var(--text-secondary)] text-[16px] leading-[1.65]">
              Send Osborn into a Zoom or Google Meet as a bot. It listens, captures
              decisions, and can turn &lsquo;we should fix that race condition&rsquo; into
              actual work the moment the call ends.
            </p>
          </div>

          {/* Meeting sliver */}
          <div
            className="rounded-2xl border border-[var(--border)] p-5"
            style={{ background: 'var(--surface)' }}
            aria-hidden="true"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                in-call · Zoom
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--voice-error)]">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--voice-error)]" />
                REC
              </span>
            </div>
            <div className="mt-4 flex flex-col gap-3 font-mono text-[12px]">
              <p className="text-[var(--text-secondary)]">
                <span className="text-[var(--text-muted)]">14:02 </span>
                &ldquo;we should fix that race condition before launch&rdquo;
              </p>
              <div className="h-px bg-[var(--border-subtle)]" />
              <p className="flex items-start gap-2 text-[var(--accent)]">
                <span>→</span>
                <span>action captured: patch race condition in job queue</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
