/**
 * lens-library-sweep.ts — the Library's CATCH-UP SWEEP (runs in the detached worker).
 *
 * The per-session step writes at most one page per run (the period that just ended). The sweep
 * writes the rest of the backlog across every session on this machine except the live ones:
 *   - every unwritten period that spans >= the min span (libraryBacklog: older closed periods,
 *     gaps between written pages, tails of ended sessions), one page each via runLibraryStep;
 *   - one daily digest per past local day for the chats too short to become a period
 *     (lens-library-digest.ts).
 * Newest work first, at most SWEEP_MAX_PAGES model-call pages a run (periods and digests
 * together), so spend stays bounded and the backlog clears over several runs. Each period or
 * day gets one attempt per run; repeat failures stop being retried (MAX_*_FAILURES).
 * Idempotent through the manifests: a written period or digested day is never redone.
 *
 * Locking: the caller holds the machine-wide sweep lock (<claudeDir>/osb-library) and no project
 * lock. Each period takes its project's lock for the length of its write (skipped when another
 * worker has it), and periods in a project a live session uses wait for a later run, so the sweep
 * never keeps a live session's compaction run out. A dry run writes only under <home>/dry. Result + backlog go to library-sweep-status.json there (read by /health), the log to
 * content-lens.log there. Never throws.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isContentLensEnabled } from './lens-launch.js'
import { SWEEP_COOLDOWN_MS, readLiveSessions, acquireLock, libraryHomeDir, releaseLock, sweepCoolingDown, touchLock, writeSweepStatus, type SweepError, type SweepStatus } from './lens-paths.js'
import { logLine } from './lens-profile.js'
import { libraryBacklog, libraryDirFor, libraryMinSpanMs, readManifest, runLibraryStep, type ManifestEntry } from './lens-library.js'
import type { LibraryPeriod } from './lens-library-select.js'
import { isTransportError } from './lens-model.js'
import { DIGEST_CAP_USD, chatKey, digestDir, ingestPendingDigests, pendingDigestDays, readDigestManifest, removeDigestDay, runDigestDay, writeDigestManifest, type ShortChat } from './lens-library-digest.js'
import { CapError, LIBRARY_LEDGER_SCOPE, SpendGuard, libraryDailyUsd, type Reservation } from './content-llm.js'
import { PERIOD_CAP_USD } from './period-run.js'
import { loadClientRedactor } from './lens-redact.js'
import { listSessionDbs, type SessionStore } from './lens-db.js'
import { writeAtomic } from './content-manifest.js'
import { redactSecrets } from './transcript-sanitizer.js'

const SWEEP_MAX_PAGES = 10
/** No new page is started after this long; the worker's hard timeout sits above it. */
const SWEEP_BUDGET_MS = 60 * 60_000
const SCAN_CACHE_FILE = 'sweep-scan.json'

export interface SweepOptions {
  /** Live sessions: never swept. */
  exclude?: string[]
  trigger?: string
  maxPages?: number
  /** No model calls (pages/digests marked dry, never counted as written). */
  dry?: boolean
  now?: number
  /** Skip the run when the last one finished this recently (default SWEEP_COOLDOWN_MS; the manual CLI passes 0). */
  cooldownMs?: number
}

/** Changes whenever the store does (WAL included). */
function fingerprint(db: string): string {
  const f = (p: string) => {
    try {
      const s = statSync(p)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return '-'
    }
  }
  return `${f(db)}|${f(`${db}-wal`)}`
}

/** A settled session: its store fingerprint, and its short chats (a digest day is always rewritten whole). */
interface ScanEntry {
  fp: string
  short: LibraryPeriod[]
}

function readScanCache(home: string): Record<string, ScanEntry> {
  try {
    const o = JSON.parse(readFileSync(join(home, SCAN_CACHE_FILE), 'utf-8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

function writeScanCache(home: string, c: Record<string, ScanEntry>): void {
  try {
    writeAtomic(join(home, SCAN_CACHE_FILE), JSON.stringify(c) + '\n')
  } catch {
    /* a missing cache only costs a rescan */
  }
}

type Item =
  | { kind: 'period'; s: SessionStore; p: LibraryPeriod; at: number }
  | { kind: 'digest'; day: string; chats: ShortChat[]; at: number }

/** An error as one redacted line of at most 200 chars: what the status file keeps (SweepError, workerError). */
export const errorLine = (e: unknown): string => redactSecrets(String(e instanceof Error ? e.message : e).replace(/\s+/g, ' '), { assistant: true }).slice(0, 200)

/** Run one sweep. Never throws; returns the status it wrote. */
export async function runLibrarySweep(o: SweepOptions = {}): Promise<SweepStatus> {
  const home = libraryHomeDir()
  const log = (m: string) => logLine(home, `sweep: ${m}`)
  const maxPages = o.maxPages ?? SWEEP_MAX_PAGES
  const deadline = Date.now() + SWEEP_BUDGET_MS
  const now = o.now ?? Date.now()
  const st: SweepStatus = {
    status: 'running', trigger: o.trigger ?? 'manual', at: new Date().toISOString(), finishedAt: null, pid: process.pid,
    pagesWritten: 0, digestsWritten: 0, modelCalls: 0, costUsd: 0, capHit: false, errors: [], backlog: undefined,
  }
  const err = (e: SweepError) => {
    st.errors.push(e)
    log(`${e.kind}${e.ref ? ` ${e.ref}` : ''}: ${e.message ?? ''}`)
  }
  // A dry run writes nothing real: no status file, scan cache, manifest or digest (pages go to <home>/dry).
  const save = () => {
    if (!o.dry) writeSweepStatus(st, home)
  }
  const finish = (status: SweepStatus['status']): SweepStatus => {
    st.status = status
    st.finishedAt = new Date().toISOString()
    st.costUsd = +st.costUsd.toFixed(4)
    save()
    return st
  }
  const alive = () => touchLock(home)
  try {
    if (!isContentLensEnabled()) return finish('disabled')
    if (!o.dry && !(process.env.OPENROUTER_API_KEY || '').trim()) return finish('no-key')
    if (sweepCoolingDown(o.cooldownMs ?? SWEEP_COOLDOWN_MS, home)) {
      log(`${st.trigger}: skipped, the last sweep finished under ${Math.round((o.cooldownMs ?? SWEEP_COOLDOWN_MS) / 60_000)} min ago`)
      return { ...st, status: 'cooldown', finishedAt: new Date().toISOString() } // the last result stays on /health
    }
    save()
    // Every page and digest call is charged to the Library's own daily cap (OSBORN_LIBRARY_DAILY_USD) in
    // the machine ledger, apart from the content step's: the worst case is reserved before the call
    // and settled to the actual cost (an unsettled one, from a killed sweep, expires with its day).
    const guard = new SpendGuard(null, { periodUsd: Number.POSITIVE_INFINITY, dailyUsd: libraryDailyUsd(), maxPieces: 0 }, 0, deadline, LIBRARY_LEDGER_SCOPE)
    const exclude = new Set((o.exclude ?? []).filter(Boolean))
    const minSpan = libraryMinSpanMs()

    // 1. Scan: every session's backlog (skipping live ones and those settled since the last scan).
    const cache = readScanCache(home)
    const nextCache: Record<string, ScanEntry> = {}
    const scanned: { s: SessionStore; fp: string; periods: number; short: LibraryPeriod[]; written: ManifestEntry[] }[] = []
    const items: Item[] = []
    const shortChats: ShortChat[] = []
    const stores = listSessionDbs()
    // A live session's project is left alone: its compaction run must find the project lock free.
    const liveProjects = new Set(stores.filter(s => exclude.has(s.sessionId)).map(s => s.projectDir))
    let livePeriods = 0
    // Sessions whose short chats are known this run (scanned, or from the cache): a digest day is only
    // rewritten when every chat it holds comes from one of them, so a rewrite never drops a chat.
    const known = new Set<string>()
    for (const s of stores) {
      if (Date.now() > deadline) {
        st.capHit = true
        err({ kind: 'time', message: 'time budget reached while scanning; the rest waits for the next run' })
        break
      }
      const hit = cache[s.sessionId]
      if (exclude.has(s.sessionId)) {
        // Live: never scanned, but its last settled short chats still belong to their days.
        if (hit && Array.isArray(hit.short)) {
          nextCache[s.sessionId] = hit
          for (const p of hit.short) shortChats.push({ ...s, period: p })
          known.add(s.sessionId)
        }
        continue
      }
      const fp = `${fingerprint(s.db)}|${minSpan}`
      if (hit?.fp === fp && Array.isArray(hit.short)) {
        nextCache[s.sessionId] = hit
        for (const p of hit.short) shortChats.push({ ...s, period: p })
        known.add(s.sessionId)
        continue
      }
      try {
        const manifest = readManifest(libraryDirFor(s.db, s.sessionId), s.sessionId)
        const b = libraryBacklog(s.db, manifest, minSpan, m => log(`${s.sessionId.slice(0, 8)} ${m}`))
        if (b.periods.length && liveProjects.has(s.projectDir)) {
          livePeriods += b.periods.length
          log(`${s.sessionId.slice(0, 8)}: ${b.periods.length} period(s) wait — a live session uses this project`)
        } else for (const p of b.periods) items.push({ kind: 'period', s, p, at: Date.parse(p.toTs) || 0 })
        for (const p of b.short) shortChats.push({ ...s, period: p })
        scanned.push({ s, fp, periods: b.periods.length, short: b.short, written: Object.values(manifest.periods).filter(e => e.status === 'ok') })
        known.add(s.sessionId)
      } catch (e) {
        err({ kind: 'scan', ref: s.sessionId.slice(0, 8), message: errorLine(e) })
      }
      alive()
    }
    const dDir = digestDir(home)
    const dryDir = join(home, 'dry')
    const dm = readDigestManifest(dDir)
    // A digested chat is stale once a written ("ok") page of its session covers its start row: its
    // day is rewritten without it, or emptied / removed when nothing is left.
    const pages = new Map(scanned.map(x => [x.s.sessionId, x.written]))
    const stale = new Set(Object.values(dm.days).flatMap(e => e.chats).filter(k => {
      const cut = k.lastIndexOf(':')
      const start = Number(k.slice(cut + 1).split('-')[0])
      return (pages.get(k.slice(0, cut)) ?? []).some(e => start >= e.startRowId && start <= e.endRowId)
    }))
    const { days, today, emptied } = pendingDigestDays(shortChats, dm, now, stale)
    const scrubAll = (s: string) => redactSecrets(loadClientRedactor(null).redact(s), { assistant: true })
    if (!o.dry) for (const day of emptied) await removeDigestDay(dDir, day, { scrub: scrubAll, log })
    const onDisk = new Set(stores.map(s => s.sessionId))
    const sessionOf = (k: string) => k.slice(0, k.lastIndexOf(':'))
    for (const [day, chats] of days) {
      const unknown = (dm.days[day]?.chats ?? []).filter(k => onDisk.has(sessionOf(k)) && !known.has(sessionOf(k)))
      if (unknown.length) {
        log(`digest ${day}: waits — ${unknown.length} of its chat(s) come from a session not read this run`)
        continue
      }
      items.push({ kind: 'digest', day, chats, at: Math.max(...chats.map(c => Date.parse(c.period.toTs) || 0)) })
    }
    // Settled = nothing pending for it now; skipped by later scans until its store changes.
    const waiting = new Set([...today, ...[...days.values()].flat()].map(c => c.sessionId))
    for (const x of scanned) if (!x.periods && !waiting.has(x.s.sessionId)) nextCache[x.s.sessionId] = { fp: x.fp, short: x.short }
    if (!o.dry) writeScanCache(home, nextCache)
    items.sort((a, b) => b.at - a.at)
    log(`${st.trigger}: ${items.filter(i => i.kind === 'period').length} period(s), ${days.size} digest day(s) pending, ${today.length} chat(s) today; cap ${maxPages}`)

    // 2. Write, newest first, under the cap. One attempt per period/day per run.
    let periodsDone = 0
    let emptyDays = 0
    let infraFails = 0
    let calls = 0
    const reserve = (usd: number): Reservation | null | 'cap' => {
      if (o.dry) return null
      try {
        return guard.reserve(usd)
      } catch (e) {
        if (e instanceof CapError) return 'cap'
        throw e
      }
    }
    // The guard refuses for the Library's daily cap, or (its deadline) the sweep's time budget.
    const capStop = () =>
      guard.capHit === 'time'
        ? err({ kind: 'time', message: 'time budget reached; the rest waits for the next run' })
        : err({ kind: 'cap', message: 'Library daily spend cap reached' })
    for (const it of items) {
      if (calls >= maxPages || Date.now() > deadline) {
        st.capHit = true
        break
      }
      if (infraFails >= 2) {
        // An outage (bad key, provider down): stop instead of spending the cap on failing calls.
        err({ kind: it.kind, message: 'stopped: the model call failed twice in a row' })
        break
      }
      alive()
      if (it.kind === 'period') {
        const sid8 = it.s.sessionId.slice(0, 8)
        const pd = it.s.projectDir
        // A session that went live since the scan (the agent rewrites the list as it changes) leaves its project alone.
        const liveNow = readLiveSessions()
        if (liveNow && stores.some(x => liveNow.includes(x.sessionId) && x.projectDir === pd)) {
          livePeriods++
          log(`${sid8}: a session in this project went live — next run`)
          continue
        }
        if (!acquireLock(pd)) {
          log(`${sid8}: project busy (another worker holds its lock) — next run`)
          continue
        }
        const held = reserve(PERIOD_CAP_USD)
        if (held === 'cap') {
          releaseLock(pd)
          st.capHit = true
          capStop()
          break
        }
        let spent = 0
        try {
          const r = await runLibraryStep({
            sessionId: it.s.sessionId, projectDir: pd, period: it.p, dry: o.dry,
            ...(o.dry ? { outDir: join(dryDir, it.s.sessionId.slice(0, 8)) } : {}),
            keepAlive: () => {
              alive()
              touchLock(pd)
            },
            log: m => log(`${sid8} ${m}`),
          })
          spent = r.costUsd
          st.costUsd += r.costUsd
          if (r.status === 'written' || r.status === 'dry' || r.status === 'model-error') calls++
          if (r.status === 'written') st.pagesWritten++
          if (r.status === 'written' || r.status === 'already-written') periodsDone++
          if (r.status === 'model-error' || r.status === 'failed') err({ kind: 'period', ref: sid8, message: errorLine(r.errors.join('; ')) })
          infraFails = r.status === 'failed' || isTransportError(r.errors) ? infraFails + 1 : 0
        } finally {
          if (held) guard.settle(held, spent)
          releaseLock(pd)
        }
      } else {
        const held = reserve(DIGEST_CAP_USD)
        if (held === 'cap') {
          st.capHit = true
          capStop()
          break
        }
        const r = await runDigestDay({ day: it.day, chats: it.chats, dir: o.dry ? join(dryDir, 'digests') : dDir, dry: o.dry, log })
        if (held) guard.settle(held, r.costUsd)
        st.costUsd += r.costUsd
        if (r.status === 'written' || r.status === 'dry' || r.status === 'model-error') calls++
        if (r.status === 'empty') emptyDays++
        if (r.status === 'written') st.digestsWritten++
        if (r.status === 'model-error' || r.status === 'failed') err({ kind: 'digest', ref: it.day, message: errorLine(r.errors.join('; ')) })
        infraFails = r.status === 'failed' || isTransportError(r.errors) ? infraFails + 1 : 0
      }
      st.modelCalls = calls
      save()
    }
    st.modelCalls = calls

    // 3. Digests whose cloud ingest never landed (no model call).
    if (!o.dry) {
      const m = readDigestManifest(dDir)
      if (await ingestPendingDigests(dDir, m, { scrub: scrubAll, log })) writeDigestManifest(dDir, m)
    }

    const pendingPeriods = items.filter(i => i.kind === 'period').length - periodsDone + livePeriods
    st.backlog = { periods: Math.max(0, pendingPeriods), digestDays: Math.max(0, days.size - st.digestsWritten - emptyDays), todayChats: today.length }
    log(`done: ${st.pagesWritten} page(s), ${st.digestsWritten} digest(s), ${calls} call(s), $${st.costUsd.toFixed(4)}; left: ${st.backlog.periods} period(s), ${st.backlog.digestDays} digest day(s)${st.capHit ? ' — cap reached' : ''}`)
    return finish('done')
  } catch (e) {
    err({ kind: 'worker', message: errorLine(e) })
    return finish('error')
  }
}
