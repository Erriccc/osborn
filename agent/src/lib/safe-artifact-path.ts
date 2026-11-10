/**
 * Robust path validation for the artifact read gate and the write /
 * auto-approve permission gates.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The pre-existing gates tested membership with a SUBSTRING check, e.g.
 *     filePath.includes('/osb/')
 *     filePath.includes('.osborn/sessions/')
 *     filePath.includes('.osborn/research/')
 *     filePath.includes('.claude/plans/')
 * A substring test is trivially defeated by `..` traversal: a path like
 *     /workspace/osb/../../../etc/passwd
 *     /tmp/osb/../../etc/passwd
 * contains the literal substring "/osb/" yet RESOLVES to a file outside the
 * workspace. The `get_research_artifact` / `get_plan_file` data-channel
 * handlers are read-only and un-gated by owner/controller, so ANY room
 * participant could use them to read + exfiltrate arbitrary files off the
 * machine. The same weak test also gated write auto-approval, so a traversal
 * path could widen which writes got approved without a prompt.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 *  1. resolve() the path — collapses `..`/`.` and makes it absolute.
 *  2. Canonicalize symlinks on the deepest EXISTING ancestor (defeats a
 *     symlinked parent dir used to escape a root) while still accepting a
 *     not-yet-existing leaf (needed by the write/auto-approve gates, where the
 *     target file is about to be created).
 *  3. Require the result to sit INSIDE an allowed root as a true path PREFIX
 *     (`resolved === root || resolved.startsWith(root + sep)`) — never a
 *     substring. `..`, absolute escapes and null bytes are rejected.
 */
import { realpathSync } from 'node:fs'
import { resolve, join, sep, dirname, basename, relative } from 'node:path'
import { homedir } from 'node:os'

export type ArtifactRoot = 'osb' | 'osbornSessions' | 'osbornResearch' | 'plans'

/**
 * Default root set for the session-workspace read + write gates. Mirrors the
 * roots the old substring checks intended: the per-session `/osb/` workspace
 * plus the two legacy `.osborn/` locations. (`plans` is opt-in — only the plan
 * read handler allows it.)
 */
export const WORKSPACE_ROOTS: ArtifactRoot[] = ['osb', 'osbornSessions', 'osbornResearch']

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function osbornHomeDir(): string {
  // Matches how the rest of the agent locates ~/.osborn (homedir, with an
  // OSBORN_HOME override). The legacy `.osborn/sessions|research` roots live
  // here; no active code writes to them, but we honor the location for parity.
  return (process.env.OSBORN_HOME || '').trim() || join(homedir(), '.osborn')
}

/**
 * Canonicalize an already-absolute path. realpath the deepest existing
 * ancestor (so a symlinked parent dir cannot be used to escape a root), then
 * re-append the trailing not-yet-existing segments verbatim. Those trailing
 * segments came out of resolve(), so they contain no `..` or `.` to re-open a
 * traversal. On total failure returns the input unchanged (still absolute).
 */
function canonicalize(absPath: string): string {
  let cur = absPath
  const suffix: string[] = []
  // Bounded loop — dirname() strictly converges to the filesystem root.
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync(cur)
      return suffix.length ? join(real, ...suffix) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return absPath // reached root, nothing resolved
      suffix.unshift(basename(cur))
      cur = parent
    }
  }
  return absPath
}

/** True iff `resolved` (already canonical) is inside the canonicalized `root`. */
function isInside(resolved: string, root: string): boolean {
  const r = canonicalize(resolve(root))
  return resolved === r || resolved.startsWith(r + sep)
}

/**
 * True iff `filePath` resolves to a location strictly inside one of the
 * `allowed` roots. Rejects null bytes, `..` traversal and absolute escapes
 * implicitly via the resolve()+canonicalize()+prefix test — never a substring.
 *
 * @param filePath  caller-supplied path (may be relative or not-yet-existing)
 * @param allowed   which roots to accept (defaults to the workspace roots)
 */
export function isSafeArtifactPath(
  filePath: string,
  allowed: ArtifactRoot[] = WORKSPACE_ROOTS,
): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  if (filePath.includes('\0')) return false // null byte — reject outright

  let resolved: string
  try {
    resolved = canonicalize(resolve(filePath))
  } catch {
    return false
  }

  for (const root of allowed) {
    if (root === 'osb') {
      // ~/.claude/projects/<slug>/osb/<sessionId>/...  (and the session-sharing
      // index layout ~/.claude/projects/osb/<slug>/...). Require containment
      // under ~/.claude/projects AND a real `osb` path COMPONENT — a `..` that
      // climbed out of projects fails the prefix test; `osb` as a substring of
      // some other name (e.g. `osbornish`) is not a component and fails too.
      const projectsRoot = canonicalize(resolve(join(claudeConfigDir(), 'projects')))
      if (resolved === projectsRoot || resolved.startsWith(projectsRoot + sep)) {
        const rel = relative(projectsRoot, resolved)
        if (rel && !rel.startsWith('..') && rel.split(sep).includes('osb')) return true
      }
    } else if (root === 'osbornSessions') {
      if (isInside(resolved, join(osbornHomeDir(), 'sessions'))) return true
    } else if (root === 'osbornResearch') {
      if (isInside(resolved, join(osbornHomeDir(), 'research'))) return true
    } else if (root === 'plans') {
      if (isInside(resolved, join(claudeConfigDir(), 'plans'))) return true
    }
  }
  return false
}
