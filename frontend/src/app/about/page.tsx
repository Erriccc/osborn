/**
 * /about — the Voice Native story. Server component wrapped in MarketingShell.
 * Linked from the landing footer (previously a dead/missing page).
 */

import Link from 'next/link'
import type { Metadata } from 'next'
import MarketingShell from '@/components/marketing/MarketingShell'
import { SITE_URL } from '@/lib/supabase-anon'

export const metadata: Metadata = {
  title: 'About — Voice Native',
  description:
    'Voice Native is an AI engineer you talk to. It writes, runs, and debugs code on your own machine while you watch — hands-free.',
  alternates: { canonical: `${SITE_URL}/about` },
  openGraph: {
    title: 'About — Voice Native',
    description: 'An AI engineer you talk to. It ships on your machine while you watch.',
    url: `${SITE_URL}/about`,
    type: 'website',
    images: [{ url: `${SITE_URL}/og.png` }],
  },
  twitter: { card: 'summary_large_image', title: 'About — Voice Native' },
}

const PRINCIPLES: { title: string; body: string }[] = [
  {
    title: 'Your code never leaves your machine',
    body: 'The agent works in your own environment — your files, your sandbox, your keys. We are a voice and a brain, not a place your source code has to live.',
  },
  {
    title: 'Bring your own keys, no lock-in',
    body: 'Plug in your own model provider keys. You are never trapped in our pricing or our models, and you can walk away with everything.',
  },
  {
    title: 'You stay in the loop',
    body: 'It dispatches a team of specialist sub-agents and narrates every move in real time. You watch the work happen and steer it by talking.',
  },
  {
    title: 'Hands-free by design',
    body: 'Speak to it like a teammate — from your desk, your couch, or the passenger seat. The interface is a conversation, not a wall of panels.',
  },
]

export default function AboutPage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[72ch] px-6 pt-16 pb-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">About Voice Native</p>
        <h1 className="mt-3 font-display text-4xl sm:text-5xl font-medium tracking-tight text-[var(--text-primary)] leading-[1.1]">
          An AI engineer you talk to.
        </h1>
        <p className="mt-5 text-[17px] text-[var(--text-secondary)] leading-relaxed">
          Most AI coding tools still make you type into a box and read the results. Voice Native is different: you
          speak to it like a colleague, and it writes, runs, and debugs code on your own machine while you watch
          every step. It dispatches a team of specialist sub-agents under the hood and keeps you in the loop the
          whole way through.
        </p>
        <p className="mt-4 text-[16px] text-[var(--text-secondary)] leading-relaxed">
          We started from a simple belief: the fastest way to build is to think out loud with something that can
          actually do the work. No context-switching into an IDE, no copy-pasting between a chat window and your
          terminal — just a conversation that ships.
        </p>
      </section>

      <section className="mx-auto max-w-[1200px] px-6 py-12 border-t border-[var(--border-subtle)]">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">What we stand for</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <div key={p.title} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6">
              <h3 className="font-display text-xl text-[var(--text-primary)]">{p.title}</h3>
              <p className="mt-2 text-[14px] text-[var(--text-secondary)] leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto max-w-[1200px] px-6 py-14 text-center">
          <h2 className="font-display text-2xl sm:text-3xl text-[var(--text-primary)]">Talk to it. It ships.</h2>
          <p className="mt-2 text-[14px] text-[var(--text-secondary)]">See what it feels like to build by voice.</p>
          <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/login"
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-5 py-3 text-[14px] font-semibold text-[var(--background)] hover:opacity-90 active:scale-[0.98] transition-all">
              Start talking — free
            </Link>
            <Link href="/blog"
              className="text-[14px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors">
              Read the blog →
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  )
}
