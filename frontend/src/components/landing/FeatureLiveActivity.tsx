import LiveSessionMock from './LiveSessionMock'

export default function FeatureLiveActivity() {
  return (
    <section aria-labelledby="live-activity-heading">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28 border-t border-[var(--border-subtle)]">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div>
            <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Live activity
            </span>
            <h2
              id="live-activity-heading"
              className="font-display mt-4 text-[var(--text-primary)] text-[clamp(1.9rem,4.5vw,2.8rem)] leading-[1.05] tracking-[-0.02em] font-semibold"
            >
              See exactly what it&rsquo;s doing. The whole time.
            </h2>
            <p className="mt-5 max-w-[34rem] text-[var(--text-secondary)] text-[16px] leading-[1.65]">
              No black box. A live activity stream shows every running sub-agent, every tool
              call, your machine&rsquo;s RAM and processes, and the code editor updating in
              real time. When an agent is reasoning, you watch it reason.
            </p>
          </div>

          <div className="flex justify-center lg:justify-end">
            <LiveSessionMock />
          </div>
        </div>
      </div>
    </section>
  )
}
