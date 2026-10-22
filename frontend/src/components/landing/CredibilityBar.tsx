export default function CredibilityBar() {
  const items = [
    'Runs on Anthropic Claude',
    'Bring your own keys',
    'Self-hosted or your cloud',
    'Your data stays yours',
  ]

  return (
    <section
      aria-label="How Osborn runs"
      className="border-y border-[var(--border-subtle)]"
      style={{ background: 'var(--surface)' }}
    >
      <div className="mx-auto max-w-[1200px] px-6 py-4">
        <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-mono text-[11px] md:text-[12px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
          {items.map((item, i) => (
            <li key={item} className="flex items-center gap-3">
              <span>{item}</span>
              {i < items.length - 1 && (
                <span className="text-[var(--text-muted)]" aria-hidden="true">·</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
