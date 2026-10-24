import Link from 'next/link'

const COLUMNS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'How it works', href: '#how-it-works' },
      { label: 'Features', href: '#features' },
      { label: 'Pricing', href: '#pricing' },
      { label: 'Start talking', href: '/login' },
    ],
  },
  {
    heading: 'Security',
    links: [
      { label: 'Your machine', href: '#security' },
      { label: 'Bring your own keys', href: '#security' },
      { label: 'No lock-in', href: '#security' },
    ],
  },
  {
    heading: 'Resources',
    links: [
      { label: 'Blog', href: '/blog' },
      { label: 'Industries', href: '/industries' },
      { label: 'Compare', href: '/compare' },
      { label: 'Use cases', href: '/use-cases' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'LinkedIn', href: 'https://www.linkedin.com/in/osbornojure/' },
      { label: 'GitHub', href: 'https://github.com/Erriccc/osborn' },
      { label: 'Contact', href: 'mailto:hello@voice-native.com' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
]

export default function LandingFooter() {
  return (
    <footer className="border-t border-[var(--border-subtle)]" style={{ background: 'var(--surface)' }}>
      <div className="mx-auto max-w-[1200px] px-6 py-16">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-10">
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {col.heading}
              </h3>
              <ul className="mt-4 flex flex-col gap-3">
                {col.links.map((l) => {
                  const isInternal = l.href.startsWith('/')
                  const cls =
                    'text-[14px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors'
                  return (
                    <li key={l.label}>
                      {isInternal ? (
                        <Link href={l.href} className={cls}>
                          {l.label}
                        </Link>
                      ) : (
                        <a href={l.href} className={cls}>
                          {l.label}
                        </a>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 pt-6 border-t border-[var(--border-subtle)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <p className="font-mono text-[12px] text-[var(--text-muted)]">
            © 2026 Voice Native · voice-native.com
          </p>
          <p className="font-display italic text-[14px] text-[var(--text-secondary)]">
            Research deeply. Build faster.
          </p>
        </div>
      </div>
    </footer>
  )
}
