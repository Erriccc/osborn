'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * /admin — admin-only users view (standalone route, deliberately not linked
 * from the dashboard). The gate here is cosmetic: on mount it probes
 * GET /api/admin/users, and the API enforces the real server-side check
 * (signed-in cookie session + email in the ADMIN_EMAILS allowlist). 401/403
 * renders a quiet card with no hints; success renders the roster.
 */

type AdminUser = {
  id: string
  email: string | null
  created_at: string | null
  last_sign_in_at: string | null
  sandbox_id: string | null
  sandbox_status: string | null
  instance_status: string | null
  last_seen: string | null
}

// ── Formatting helpers ──────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const secs = Math.floor((Date.now() - d.getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return fmtDate(iso)
}

// Machine status → color (reuses the voice-state palette). Unknown values
// fall back to muted so a new sandbox_status never renders invisible.
function statusColor(status: string | null): string {
  const s = (status ?? '').toLowerCase()
  if (!s || s === 'none' || s === 'deleted') return 'var(--text-muted)'
  if (s === 'running' || s === 'started' || s === 'ready' || s === 'healthy') return '#6faf8f'
  if (s.startsWith('stop') || s === 'paused' || s === 'suspended') return 'var(--text-secondary)'
  if (s.includes('error') || s === 'failed' || s === 'crashed') return '#c4756b'
  if (s.includes('provision') || s === 'creating' || s === 'starting' || s === 'pending') return 'var(--accent)'
  return 'var(--text-secondary)'
}

function StatusPill({ status }: { status: string | null }) {
  const label = (status ?? 'none').toLowerCase()
  const color = statusColor(status)
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color, background: 'color-mix(in srgb, ' + color + ' 14%, transparent)' }}
    >
      {label}
    </span>
  )
}

// ── Page ────────────────────────────────────────────────────────

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [denied, setDenied] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setRefreshing(true)
    setFailed(false)
    try {
      const res = await fetch('/api/admin/users', { cache: 'no-store' })
      if (res.status === 401 || res.status === 403) {
        setDenied(true)
        setUsers(null)
      } else if (res.ok) {
        const body = await res.json()
        setUsers(Array.isArray(body?.users) ? body.users : [])
        setDenied(false)
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <main className="min-h-screen bg-[var(--background)] p-6 md:p-10">
      <div className="mx-auto w-full max-w-5xl flex flex-col gap-6">

        {/* ── Header ─────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-[var(--text-primary)] text-xl font-semibold tracking-[-0.02em]">
              Admin
            </h1>
            <p className="text-[var(--text-secondary)] text-[13px] mt-0.5">
              {users ? `${users.length} signed-up ${users.length === 1 ? 'user' : 'users'}` : 'Users'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!loading && !denied && (
              <button
                onClick={load}
                disabled={refreshing}
                className="h-11 px-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--text-secondary)] text-[13px] font-medium hover:text-[var(--text-primary)] hover:bg-[var(--surface-raised)] transition-colors disabled:opacity-60"
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
            <Link
              href="/dashboard"
              className="h-11 px-4 rounded-lg inline-flex items-center text-[var(--accent)] text-[13px] font-medium hover:bg-[var(--surface)] transition-colors"
            >
              Dashboard
            </Link>
          </div>
        </div>

        {/* ── Loading ────────────────────────────────────────── */}
        {loading && (
          <div className="h-40 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-[var(--border-subtle)] border-t-[var(--accent)] rounded-full animate-spin" />
          </div>
        )}

        {/* ── Denied: quiet card, no hints ───────────────────── */}
        {!loading && denied && (
          <div className="mx-auto mt-16 w-full max-w-[360px] bg-[var(--surface)] border border-[var(--border-subtle)] rounded-2xl p-8 flex flex-col items-center gap-3">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
              stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="11" width="16" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <p className="text-[var(--text-secondary)] text-sm text-center">Admin access required</p>
          </div>
        )}

        {/* ── Load failed ────────────────────────────────────── */}
        {!loading && !denied && failed && (
          <div className="mx-auto mt-16 w-full max-w-[360px] bg-[var(--surface)] border border-[var(--border-subtle)] rounded-2xl p-8 flex flex-col items-center gap-4">
            <p className="text-[var(--text-secondary)] text-sm text-center">Could not load users</p>
            <button
              onClick={load}
              disabled={refreshing}
              className="h-11 px-5 rounded-xl font-semibold text-[14px] transition-all duration-150 active:scale-[0.98] disabled:opacity-60"
              style={{
                background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-dim) 100%)',
                color: 'var(--background)',
              }}
            >
              Try again
            </button>
          </div>
        )}

        {/* ── Roster: table on md+, cards on small screens ───── */}
        {!loading && !denied && !failed && users && users.length === 0 && (
          <div className="bg-[var(--surface)] border border-[var(--border-subtle)] rounded-2xl p-8">
            <p className="text-[var(--text-secondary)] text-sm text-center">No users yet</p>
          </div>
        )}

        {!loading && !denied && !failed && users && users.length > 0 && (
          <div className="bg-[var(--surface)] border border-[var(--border-subtle)] rounded-2xl overflow-hidden">

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-[var(--text-secondary)] text-[11px] uppercase tracking-wider">
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Signed up</th>
                    <th className="px-4 py-3 font-medium">Last sign-in</th>
                    <th className="px-4 py-3 font-medium">Machine</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-t border-[var(--border-subtle)]">
                      <td className="px-4 py-3 text-[var(--text-primary)] text-sm truncate max-w-[220px]">
                        {u.email ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)] text-[13px] whitespace-nowrap">
                        {fmtDate(u.created_at)}
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)] text-[13px] whitespace-nowrap">
                        {fmtRelative(u.last_sign_in_at)}
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)] text-[13px] font-mono truncate max-w-[160px]">
                        {u.sandbox_id ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={u.sandbox_status ?? u.instance_status} />
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)] text-[13px] whitespace-nowrap">
                        {fmtRelative(u.last_seen)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden flex flex-col">
              {users.map((u) => (
                <div key={u.id} className="p-4 flex flex-col gap-3 border-b border-[var(--border-subtle)] last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[var(--text-primary)] text-sm font-medium truncate">
                      {u.email ?? '—'}
                    </p>
                    <StatusPill status={u.sandbox_status ?? u.instance_status} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                    <MobileField label="Signed up" value={fmtDate(u.created_at)} />
                    <MobileField label="Last sign-in" value={fmtRelative(u.last_sign_in_at)} />
                    <MobileField label="Machine" value={u.sandbox_id ?? '—'} mono />
                    <MobileField label="Last seen" value={fmtRelative(u.last_seen)} />
                  </dl>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

/* ── Mobile card field ────────────────────────────────────────── */
function MobileField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <dt className="text-[var(--text-muted)] text-[10px] uppercase tracking-wider">{label}</dt>
      <dd
        className={`text-[var(--text-secondary)] text-[13px] truncate ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
}
