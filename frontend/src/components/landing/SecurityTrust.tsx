const CARDS = [
  {
    title: 'Code stays on your machine',
    body:
      'Voice Native runs the agent on your cloud box or local machine. Your source code is read, written, and executed where it already lives — it is never uploaded to or stored on our servers.',
  },
  {
    title: 'Keys encrypted, never shown back',
    body:
      "Your API keys are stored encrypted on your own machine. Once saved, they're never displayed again — not to you, not to us. We can't leak what we never hold.",
  },
  {
    title: 'Bring your own keys',
    body:
      'Plug in your own Anthropic, OpenRouter, Fireworks, or Recall keys. You control the models, the spend, and the data path.',
  },
  {
    title: 'No lock-in',
    body:
      'Run Voice Native on infrastructure you own — self-hosted or your own cloud. No lock-in at the model, compute, or data layer.',
  },
]

export default function SecurityTrust() {
  return (
    <section id="security" className="scroll-mt-20">
      <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
        <div
          className="rounded-3xl border border-[var(--border)] p-8 md:p-12"
          style={{ background: 'var(--surface)' }}
        >
          <div className="max-w-[44rem]">
            <span className="font-mono text-[11px] md:text-[12px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Security
            </span>
            <h2 className="font-display mt-4 text-[var(--text-primary)] text-[clamp(2rem,4.5vw,3rem)] leading-[1.05] tracking-[-0.02em] font-semibold">
              Your code. Your keys. Your machine.
            </h2>
          </div>

          <div className="mt-12 grid md:grid-cols-2 gap-5">
            {CARDS.map((c) => (
              <div
                key={c.title}
                className="rounded-2xl border border-[var(--border-subtle)] p-6"
                style={{ background: 'var(--surface-raised)' }}
              >
                <h3 className="font-display text-[var(--text-primary)] text-[20px] tracking-[-0.01em] font-semibold">
                  {c.title}
                </h3>
                <p className="mt-3 text-[var(--text-secondary)] text-[15px] leading-[1.65]">
                  {c.body}
                </p>
              </div>
            ))}
          </div>

          <p className="mt-10 font-mono text-[12px] text-[var(--text-muted)] tracking-[0.02em]">
            No lock-in at the model, compute, or data layer — run it on infrastructure you own.
          </p>
        </div>
      </div>
    </section>
  )
}
