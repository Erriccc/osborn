/**
 * loops-flush-worker.ts — DETACHED worker entry for follow-through filing (#378).
 *
 *   node loops-flush-worker.js --session <id> --cwd <dir> [--reason <r>]
 *       one session (spawned by launchLoopsFlush at session end, recycle, idle exit, stop signals)
 *   node loops-flush-worker.js --last
 *       the last foreground session (spawned by bin/cli.js after an abnormal agent exit)
 *   node loops-flush-worker.js --drain
 *       every session ledger on the machine with unfiled items (next start)
 *
 * Self-contained: never throws, always exits.
 */
import { flushSession } from '../loops-flush.js'
import { readPublicSince } from '../config.js'
import { fileableLoops, listLedgers, readLoopRecordsAt } from '../loops-ledger.js'
import { readLastSession } from './lens-paths.js'
import { isFollowThroughEnabled } from './lens-launch.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  // The kill switch also covers bin/cli.js's abnormal-exit spawn, which does not check it.
  if (!isFollowThroughEnabled()) return 0
  const targets: Array<{ id: string; cwd: string }> = []
  if (process.argv.includes('--drain')) {
    for (const l of listLedgers()) {
      if (l.cwd && readPublicSince(l.cwd) && fileableLoops(readLoopRecordsAt(l.path)).length) targets.push({ id: l.sessionId, cwd: l.cwd })
    }
  } else if (process.argv.includes('--last')) {
    const last = readLastSession()
    if (last) targets.push(last)
  } else {
    const id = arg('--session')
    const cwd = arg('--cwd')
    if (id && cwd) targets.push({ id, cwd })
  }
  const reason = arg('--reason') ?? (process.argv.includes('--drain') ? 'drain' : process.argv.includes('--last') ? 'abnormal-exit' : 'session-end')
  for (const t of targets) {
    try {
      const r = await flushSession(t.id, t.cwd)
      process.stderr.write(`[follow-through] ${new Date().toISOString()} ${reason} ${t.id.slice(0, 8)}: ${r.status} filed=${r.filed}${r.repo ? ` repo=${r.repo} (${r.via === 'default' ? 'no origin in cwd, OSBORN_FOLLOW_THROUGH_DEFAULT_REPO' : 'cwd origin'})` : ''}${r.detail ? ` ${r.detail}` : ''}\n`)
    } catch (err) {
      process.stderr.write(`[follow-through] ${reason} ${t.id.slice(0, 8)}: error ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(1))
