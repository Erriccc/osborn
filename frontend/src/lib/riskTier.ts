// Risk classifier for the session-scoped "Auto-review" approval mode.
//
// The agent's `permission_request` payload carries NO severity/risk signal — only
// `toolName`, `input`, `description` and (for file edits) a `diff` (see
// agent/src/index.ts `directLLM.events.on('permission_request', …)`). So the tier
// is derived HERE, on the frontend, from the tool name + its target, and kept
// deliberately conservative: when in doubt, it is HIGH (never auto-approved).
//
//   LOW  → read-only tools, or file writes/edits whose target stays inside the
//          workspace. These auto-approve in 'auto-review' mode.
//   HIGH → everything else: destructive deletes, shell/Bash side effects,
//          network/exfil (WebFetch/WebSearch, incl. the "copy scope doc + POST
//          it" shape), out-of-workspace writes, sub-agent spawns, MCP calls, and
//          any unknown tool. NEVER auto-approved — always waits for a human.
//
// This classifier ONLY gates the frontend auto-answer. It never relaxes the
// agent-side canUseTool / PreToolUse gate: a tool the agent denies stays denied,
// and DENY always wins.

export type RiskTier = 'low' | 'high'

// The agent's working directory is the workspace root; it enforces a `/workspace`
// prefix with no traversal for every user-supplied path (see agent/src/index.ts).
const WORKSPACE_ROOT = '/workspace'

// Tools that only read — they never mutate the filesystem, run a shell, or touch
// the network, so they are always safe to auto-approve.
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
// absolute paths must live under `/workspace`. Anything with a `..` segment, a
// URL scheme, or a home-relative `~` is rejected so it can never escape.
export function isInWorkspace(rawPath: unknown): boolean {
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
  return p === WORKSPACE_ROOT || p.startsWith(WORKSPACE_ROOT + '/')
}

/**
 * Derive the risk tier for a tool request from the data in the permission_request
 * payload. Pure — no React, no I/O. Conservative by construction: anything not
 * provably LOW is HIGH.
 */
export function classifyRisk(
  toolName: string,
  input?: Record<string, unknown> | null,
): RiskTier {
  if (!toolName || typeof toolName !== 'string') return 'high'
  if (READ_ONLY_TOOLS.has(toolName)) return 'low'
  if (WORKSPACE_WRITE_TOOLS.has(toolName)) {
    return isInWorkspace(targetPath(input)) ? 'low' : 'high'
  }
  // Bash/KillShell (shell side effects), WebFetch/WebSearch (network/exfil),
  // Task (spawns an agent that can do anything), MCP tools (mcp__*), and every
  // unknown tool fall through to HIGH — never auto-approved.
  return 'high'
}

/**
 * The single question the 'auto-review' mode asks per request: may this be
 * auto-approved? True ONLY for LOW-risk requests.
 */
export function canAutoApprove(
  toolName: string,
  input?: Record<string, unknown> | null,
): boolean {
  return classifyRisk(toolName, input) === 'low'
}
