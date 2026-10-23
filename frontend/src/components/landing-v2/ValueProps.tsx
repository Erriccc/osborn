/**
 * ValueProps — the existing value props reframed through the hands-free /
 * self-driving business-OS lens. Each card gently assembles on scroll
 * (vn2-part), server-rendered, no client JS.
 */

const PROPS = [
  {
    kicker: 'Voice-first',
    title: 'Drive with your voice',
    body: 'Describe the destination in plain language. No prompts to engineer, no syntax — you talk to it the way you’d talk to the car.',
  },
  {
    kicker: 'Your machine',
    title: 'Runs where your work lives',
    body: 'The agent executes on your cloud box or local machine. Your code never leaves the seat — read, written, and run in place.',
  },
  {
    kicker: 'Agent team',
    title: 'A whole crew under the hood',
    body: 'Researcher, reasoner, writer, tester, reviewer — specialist sub-agents fan out and coordinate so one sentence turns into shipped work.',
  },
  {
    kicker: 'Memory',
    title: 'It remembers the route',
    body: 'Per-session memory with semantic recall. Decisions, your stack, last Tuesday’s bug — pick up exactly where you left off.',
  },
  {
    kicker: 'Meetings',
    title: 'Rides along to your calls',
    body: 'Send it into Zoom or Meet. It listens, captures decisions, and turns “we should fix that” into real work the moment the call ends.',
  },
  {
    kicker: 'Your keys · no lock-in',
    title: 'You own the whole stack',
    body: 'Bring your own Anthropic, OpenRouter, or Fireworks keys. You control the models, the spend, and the data path. No lock-in, anywhere.',
  },
]

export default function ValueProps() {
  return (
    <section id="features" className="scroll-mt-16">
      <div className="mx-auto max-w-[1200px] px-6 py-24 md:py-28 border-t border-[var(--border-subtle)]">
        <div className="max-w-[44rem]">
          <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
            The business OS
          </span>
          <h2 className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.02em] font-semibold">
            Hands off the keyboard. Eyes on the road.
          </h2>
          <p className="mt-5 max-w-[34rem] text-[var(--text-secondary)] text-[16px] leading-[1.65]">
            Everything you’d expect from an engineering team, re-shaped so you can
            run it with your voice while it does the driving.
          </p>
        </div>

        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {PROPS.map((p, i) => (
            <div
              key={p.kicker}
              data-vn2-part
              className={`vn2-part vn2-d${(i % 3) + 1} rounded-2xl border border-[var(--border)] p-6 flex flex-col`}
              style={{ background: 'var(--surface)' }}
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--accent)]">
                {p.kicker}
              </span>
              <h3 className="font-display mt-3 text-[var(--text-primary)] text-[20px] tracking-[-0.01em] font-semibold">
                {p.title}
              </h3>
              <p className="mt-3 text-[var(--text-secondary)] text-[14px] leading-[1.6]">
                {p.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
