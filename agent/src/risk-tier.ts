// Risk classifier for the "Auto-review" approval mode (#364).
//
// The one copy: the agent applies the approval mode itself (approval-policy.ts,
// index.ts `permission_request`), for the browser and phone calls alike, so the
// browser no longer classifies. The tier is derived from the tool name + its
// target, and kept deliberately conservative: when in doubt, it is HIGH (never
// auto-approved).
//
//   LOW  → read-only tools, or file writes/edits whose target stays inside the
//          workspace. These auto-approve in 'auto-review' mode.
//   HIGH → everything else: destructive deletes, shell/Bash side effects,
//          network/exfil (WebFetch/WebSearch, incl. the "copy scope doc + POST
//          it" shape), out-of-workspace writes, sub-agent spawns, MCP calls, and
//          any unknown tool. NEVER auto-approved — always waits for a human.
//
// This classifier ONLY decides the auto-answer to a permission request. It never
// relaxes the canUseTool / PreToolUse gate: a tool the agent denies stays denied,
// and DENY always wins.

export type RiskTier = 'low' | 'high'

// Default workspace root; the agent passes the session's working directory.
const WORKSPACE_ROOT = '/workspace'

// Tools that only read — they never mutate the filesystem, run a shell, or touch
// the network. LOW only for an in-workspace, non-sensitive target.
const READ_ONLY_TOOLS = new Set<string>([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
])

// File-mutating tools that are LOW *only* when their target stays in-workspace.
const WORKSPACE_WRITE_TOOLS = new Set<string>([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
])

// Pull the filesystem target out of a tool input, whichever field it uses.
function targetPath(input?: Record<string, unknown> | null): unknown {
  if (!input) return undefined
  return input.file_path ?? input.notebook_path ?? input.path
}

// True only when the path is unambiguously inside the workspace. Relative paths
// resolve against the agent's cwd (the workspace) and count as in-workspace;
// absolute paths must live under `root`. Anything with a `..` segment, a
// URL scheme, or a home-relative `~` is rejected so it can never escape.
export function isInWorkspace(rawPath: unknown, root: string = WORKSPACE_ROOT): boolean {
  const base = root.length > 1 ? root.replace(/\/+$/, '') : root
  if (typeof rawPath !== 'string') return false
  const p = rawPath.trim()
  if (p.length === 0) return false
  // Any traversal segment can climb out of the workspace — refuse outright.
  if (p.split(/[\\/]/).some((seg) => seg === '..')) return false
  // URL schemes (http://, file://, …) and home-relative paths are not workspace paths.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p) || p.startsWith('~')) return false
  // Relative path → resolves against cwd (the workspace).
  if (!p.startsWith('/')) return true
  // Absolute path → must be the workspace root or a descendant of it.
  // A root of "/" (or none) would make every path in-workspace: never.
  if (!base.startsWith('/') || base === '/') return false
  return p === base || p.startsWith(base + '/')
}

// Paths that change how tools, the agent or the repo behave, or hold secrets:
// any dot segment (.git, .claude, .husky, .github, .env*, node_modules/.bin,
// .githooks, .npmrc …), a hooks folder, and any settings or hook file. Never
// LOW, even inside the workspace.
export function isSensitivePath(rawPath: unknown): boolean {
  if (typeof rawPath !== 'string') return true
  const segs = rawPath.trim().split(/[\\/]+/).filter((s) => s && s !== '.')
  if (segs.some((s) => s.startsWith('.') || /^hooks?$/i.test(s))) return true
  return /settings|hook/i.test(segs[segs.length - 1] || '')
}

// Grep/Glob search the workspace (cwd) when they are given no path.
const DEFAULTS_TO_CWD = new Set<string>(['Grep', 'Glob'])

/** True for tools that only read (the whole-tool "always allow" covers only these). */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName)
}

/**
 * Derive the risk tier for a tool request from the data in the permission_request
 * payload. Pure — no React, no I/O. Conservative by construction: anything not
 * provably LOW is HIGH.
 */
export function classifyRisk(
  toolName: string,
  input?: Record<string, unknown> | null,
  workspaceRoot?: string,
): RiskTier {
  if (!toolName || typeof toolName !== 'string') return 'high'
  // LOW needs an in-workspace (session cwd), non-sensitive target.
  if (READ_ONLY_TOOLS.has(toolName) || WORKSPACE_WRITE_TOOLS.has(toolName)) {
    const target = targetPath(input)
    if (target === undefined && DEFAULTS_TO_CWD.has(toolName)) return 'low'
    return isInWorkspace(target, workspaceRoot) && !isSensitivePath(target) ? 'low' : 'high'
  }
  // Bash/KillShell (shell side effects), WebFetch/WebSearch (network/exfil),
  // Task (spawns an agent that can do anything), MCP tools (mcp__*), and every
  // unknown tool fall through to HIGH — never auto-approved.
  return 'high'
}
