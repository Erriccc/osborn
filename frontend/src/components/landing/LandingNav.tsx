'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createSupabaseBrowser } from '@/lib/supabase-browser'

const LINKS = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#security', label: 'Security' },
  { href: '#pricing', label: 'Pricing' },
  { href: '/blog', label: 'Blog' },
]

export default function LandingNav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Auth-aware CTAs: signed-in visitors can hang out on the landing and get
  // "Open dashboard" instead of "Sign in / Start talking". Use getSession()
  // (reads the locally-stored session, no slow network validation) + subscribe
  // so it reflects reality immediately and on sign-in/out.
  useEffect(() => {
    const supabase = createSupabaseBrowser()
    supabase.auth.getSession().then(({ data }) => setAuthed(!!data.session)).catch(() => {})
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setAuthed(!!session))
    return () => sub.subscription.unsubscribe()
  }, [])

  // Lock body scroll while the mobile sheet is open
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = prev }
    }
  }, [open])

  // iPad rotate: crossing into lg hides the sheet via CSS but left the page
  // scroll-locked. Close it explicitly so the body-overflow lock clears.
  useEffect(() => {
    const onResize = () => { if (window.matchMedia('(min-width: 1024px)').matches) setOpen(false) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <header
      className="fixed top-0 inset-x-0 z-50 transition-colors duration-300"
      style={{
        background: scrolled ? 'color-mix(in srgb, var(--surface) 88%, transparent)' : 'transparent',
        borderBottom: scrolled ? '1px solid var(--border-subtle)' : '1px solid transparent',
        backdropFilter: scrolled ? 'blur(12px)' : 'none',
        WebkitBackdropFilter: scrolled ? 'blur(12px)' : 'none',
      }}
    >
      <nav className="mx-auto max-w-[1200px] px-6 h-16 flex items-center justify-between">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2.5 group" aria-label="Voice Native home">
          <OrbMark size={28} />
          <span className="font-display text-[var(--text-primary)] text-[20px] font-semibold tracking-[-0.02em]">
            Voice Native
          </span>
        </Link>

        {/* Center links (desktop) */}
        <ul className="hidden lg:flex items-center gap-8">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        {/* Right actions (desktop) */}
        <div className="hidden lg:flex items-center gap-4 whitespace-nowrap shrink-0">
          {authed ? (
            <Link
              href="/dashboard"
              className="h-9 px-4 inline-flex items-center gap-1.5 rounded-full text-[14px] font-medium tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
              style={{
                background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                color: 'var(--background)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
              }}
            >
              Open dashboard
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="font-mono text-[12px] uppercase tracking-[0.08em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                Sign in
              </Link>
              <Link
                href="/login"
                className="h-9 px-4 inline-flex items-center rounded-full text-[14px] font-medium tracking-[-0.01em] transition-all duration-150 active:scale-[0.98]"
                style={{
                  background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                  color: 'var(--background)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
                }}
              >
                Start talking
              </Link>
            </>
          )}
        </div>

        {/* Hamburger (mobile) */}
        <button
          type="button"
          className="lg:hidden w-10 h-10 -mr-2 flex flex-col items-center justify-center gap-[5px]"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span
            className="block w-5 h-px bg-[var(--text-primary)] transition-transform duration-200"
            style={{ transform: open ? 'translateY(6px) rotate(45deg)' : 'none' }}
          />
          <span
            className="block w-5 h-px bg-[var(--text-primary)] transition-opacity duration-200"
            style={{ opacity: open ? 0 : 1 }}
          />
          <span
            className="block w-5 h-px bg-[var(--text-primary)] transition-transform duration-200"
            style={{ transform: open ? 'translateY(-6px) rotate(-45deg)' : 'none' }}
          />
        </button>
      </nav>

      {/* Mobile sheet */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 top-16 z-40"
          style={{ background: 'var(--background)' }}
        >
          <div className="px-6 py-8 flex flex-col gap-6 border-t border-[var(--border-subtle)]">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="font-mono text-[14px] uppercase tracking-[0.08em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                {l.label}
              </a>
            ))}
            <div className="h-px bg-[var(--border-subtle)] my-2" />
            {authed ? (
              <Link
                href="/dashboard"
                onClick={() => setOpen(false)}
                className="h-12 inline-flex items-center justify-center gap-2 rounded-xl text-[15px] font-semibold tracking-[-0.01em]"
                style={{
                  background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                  color: 'var(--background)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
                }}
              >
                Open dashboard
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="font-mono text-[14px] uppercase tracking-[0.08em] text-[var(--text-secondary)]"
                >
                  Sign in
                </Link>
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className="h-12 inline-flex items-center justify-center rounded-xl text-[15px] font-semibold tracking-[-0.01em]"
                  style={{
                    background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                    color: 'var(--background)',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)',
                  }}
                >
                  Start talking
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  )
}

/* ── Orb mark (shared brand glyph) ─────────────────────── */
function OrbMark({ size = 28 }: { size?: number }) {
  return (
    <span className="relative inline-block" style={{ width: size, height: size }}>
      <span
        className="absolute inset-0 rounded-full"
        style={{
          background: 'radial-gradient(circle at 35% 35%, var(--accent) 0%, var(--accent-dim) 100%)',
          boxShadow: '0 0 16px var(--accent-glow), inset 0 -2px 6px rgba(0,0,0,0.3)',
        }}
      />
      <svg
        className="absolute inset-0 m-auto"
        width={size * 0.5}
        height={size * 0.5}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--background)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    </span>
  )
}
