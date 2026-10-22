const STEPS = [
  {
    n: '01',
    title: 'Talk to it',
    body:
      "Join a voice room and describe what you want in plain language — 'add Stripe billing,' 'find why the deploy is flaking,' 'refactor the auth module.' Osborn listens, asks clarifying questions, and plans out loud.",
  },
  {
    n: '02',
    title: 'It works on your machine',
    body:
      'Osborn writes and runs real code on your cloud box or local machine — editing files, running tests, hitting your services. Nothing is simulated and nothing is copied to our servers.',
  },
  {
    n: '03',
    title: 'Watch the team work',
    body:
      'A crew of specialist sub-agents fans out — research, reasoning, writing, testing, review. You see every running agent, every file change, and live machine stats as it happens, and you can cut in by voice at any time.',
  },
]

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
        <div className="max-w-[40rem]">
          <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
            How it works
          </span>
          <h2 className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.02em] font-semibold">
            Three steps. No prompt-wrangling.
          </h2>
        </div>

        <ol className="mt-14 grid md:grid-cols-3 gap-8 md:gap-10">
          {STEPS.map((s) => (
            <li key={s.n} className="flex flex-col">
              <span className="font-mono text-[13px] tracking-[0.1em] text-[var(--accent)]">
                {s.n}
              </span>
              <div className="mt-4 h-px bg-[var(--border-subtle)]" />
              <h3 className="font-display mt-5 text-[var(--text-primary)] text-[22px] md:text-[24px] tracking-[-0.01em] font-semibold">
                {s.title}
              </h3>
              <p className="mt-3 text-[var(--text-secondary)] text-[15px] leading-[1.65]">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
