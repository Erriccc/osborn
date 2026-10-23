/**
 * /founders — niche landing page for solo founders & indie builders.
 * Angle: ship your idea hands-free, bring your own keys, no lock-in, a whole
 * engineering team behind one person. Shares MarketingShell chrome; focused
 * single-purpose conversion body. Server component.
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import MarketingShell from '@/components/marketing/MarketingShell'
import { SITE_URL } from '@/lib/supabase-anon'

export const metadata: Metadata = {
  title: 'Voice Native for solo founders — ship your idea hands-free',
  description:
    'You are the whole team. Voice Native gives you an AI engineering crew you talk to — it writes, runs, and debugs on your machine while you keep everything else moving. Bring your own keys. No lock-in.',
  alternates: { canonical: `${SITE_URL}/founders` },
  openGraph: {
    title: 'Voice Native for solo founders',
    description: 'An AI engineering crew you talk to. Ship your idea hands-free — your machine, your keys, no lock-in.',
    url: `${SITE_URL}/founders`,
    type: 'website',
    images: [{ url: `${SITE_URL}/og.png` }],
  },
  twitter: { card: 'summary_large_image', title: 'Voice Native for solo founders' },
}

const VALUE: { title: string; body: string }[] = [
  {
    title: 'Ship while you do everything else',
    body: 'You are the founder, the marketer, the support desk. Talk your feature into existence between calls — it builds, runs, and debugs on its own while you keep moving.',
  },
  {
    title: 'A whole team behind one person',
    body: 'It dispatches specialist sub-agents — one researches, one writes, one reviews — and narrates every move. The leverage of a team without the headcount.',
  },
  {
    title: 'Your machine, your keys, no lock-in',
    body: 'Code runs in your own environment. Plug in your own model keys and pay providers directly. Nothing to rip out later — you own all of it.',
  },
]

const STEPS: { n: string; title: string; body: string }[] = [
  { n: '01', title: 'Say what you want', body: 'Describe the feature, the fix, or the whole idea — in plain words, like briefing a teammate.' },
  { n: '02', title: 'Watch it work', body: 'It writes and runs the code on your machine, dispatching sub-agents, showing every step in real time.' },
  { n: '03', title: 'Steer by talking', body: 'Interrupt, redirect, refine — all by voice. When it is right, it is already shipped where you work.' },
]

export default function FoundersPage() {
  return (
    <MarketingShell>
      {/* Hero */}
      <section className="mx-auto max-w-[1200px] px-6 pt-20 pb-14">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">For solo founders &amp; builders</p>
        <h1 className="mt-4 font-display text-4xl sm:text-6xl font-medium tracking-tight text-[var(--text-primary)] leading-[1.05] max-w-[18ch]">
          You&apos;re the whole team. Now you have <span className="italic text-[var(--accent)]">engineers.</span>
        </h1>
        <p className="mt-6 max-w-[58ch] text-[17px] sm:text-[19px] text-[var(--text-secondary)] leading-relaxed">
          Voice Native is an AI engineering crew you talk to. It writes, runs, and debugs code on your own machine
          while you keep everything else moving — hands-free. Bring your own keys. No lock-in. No team required.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <Link href="/login"
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-6 py-3.5 text-[15px] font-semibold text-[var(--background)] hover:opacity-90 active:scale-[0.98] transition-all">
            Start talking — free
          </Link>
          <Link href="/compare" className="text-[14px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors">
            See how it compares →
          </Link>
        </div>
        <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Your code never leaves your machine · Bring your own keys · No lock-in
        </p>
      </section>

      {/* Value props */}
      <section className="mx-auto max-w-[1200px] px-6 py-12 border-t border-[var(--border-subtle)]">
        <div className="grid gap-4 sm:grid-cols-3">
          {VALUE.map((v) => (
            <div key={v.title} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6">
              <h3 className="font-display text-xl text-[var(--text-primary)] leading-snug">{v.title}</h3>
              <p className="mt-2.5 text-[14px] text-[var(--text-secondary)] leading-relaxed">{v.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-[1200px] px-6 py-12 border-t border-[var(--border-subtle)]">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">How it works</h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n}>
              <span className="font-display text-3xl text-[var(--accent)]">{s.n}</span>
              <h3 className="mt-2 font-display text-lg text-[var(--text-primary)]">{s.title}</h3>
              <p className="mt-1.5 text-[14px] text-[var(--text-secondary)] leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto max-w-[1200px] px-6 py-16 text-center">
          <h2 className="font-display text-3xl sm:text-4xl text-[var(--text-primary)] leading-tight">
            Stop being the bottleneck.
          </h2>
          <p className="mt-3 text-[15px] text-[var(--text-secondary)]">Talk your next feature into existence — free to start.</p>
          <Link href="/login"
            className="mt-7 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-6 py-3.5 text-[15px] font-semibold text-[var(--background)] hover:opacity-90 active:scale-[0.98] transition-all">
            Start talking — free
          </Link>
        </div>
      </section>
    </MarketingShell>
  )
}
