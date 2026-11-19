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

import { homedir } from 'node:os'

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

// File names that steer agents, builds, CI or deploys, or look like secrets.
const SENSITIVE_NAMES: RegExp[] = [
  /settings|hook/i,                                             // settings and hook files
  /^(?:claude|claude\.local|agents)\.md$/i,                     // agent instructions, at any depth
  /^package\.json$/i,                                           // scripts run on install/build
  /(?:^|[-.])lock(?:\.json|\.ya?ml|b)?$|\.lock$|^go\.sum$/i,    // lockfiles
  /^(?:makefile|gnumakefile|justfile|rakefile|jenkinsfile|procfile)$/i,
  /^dockerfile(?:\..+)?$|^docker-compose[\w.-]*\.ya?ml$|^compose\.ya?ml$/i,
  /\.(?:sh|bash|zsh|fish|ps1|bat|cmd)$/i,                       // shell scripts
  /^(?:azure-pipelines|bitbucket-pipelines|codemagic|cloudbuild|buildspec|appveyor)\.ya?ml$/i, // CI
  /^(?:fly|railway|nixpacks|netlify|vercel)\.(?:toml|json)$/i,  // deploy configs
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i, /^id_(?:rsa|dsa|ecdsa|ed25519)/i, /credential/i, /secret/i,
  // Files a build, install or test run executes or reads as config.
  /^(?:setup\.py|setup\.cfg|pyproject\.toml|conftest\.py|pipfile|pipfile\.lock|cargo\.toml|build\.rs|gemfile|go\.mod)$/i,
  /^requirements[\w.-]*\.txt$/i, /\.gemspec$/i,
  /\.config\.(?:js|ts|mjs|cjs|mts|cts)$/i,                      // vite/next/jest/eslint/… configs
  /^tsconfig[\w.-]*\.json$/i,
]

// Paths that change how tools, the agent, builds or the repo behave, or hold
// secrets: any dot segment (.git, .claude, .husky, .github, .gitlab-ci.yml,
// .env*, .babelrc, .githooks, .npmrc …), anything under node_modules, a hooks
// folder, and the SENSITIVE_NAMES above. Never LOW, even inside the workspace.
export function isSensitivePath(rawPath: unknown): boolean {
  if (typeof rawPath !== 'string') return true
  const segs = rawPath.trim().split(/[\\/]+/).filter((s) => s && s !== '.')
  if (segs.some((s) => s.startsWith('.') || /^hooks?$/i.test(s) || s === 'node_modules')) return true
  const base = segs[segs.length - 1] || ''
  return SENSITIVE_NAMES.some((re) => re.test(base))
}

// Grep/Glob search the workspace (cwd) when they are given no path.
const DEFAULTS_TO_CWD = new Set<string>(['Grep', 'Glob'])

/**
 * A cwd too broad to trust writes under: the filesystem root or the user's
 * home folder (its dotfiles, ssh keys and shell profile all sit "inside" it).
 */
export function isBroadRoot(root: string | undefined, home: string = homedir()): boolean {
  if (!root) return true
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  const r = norm(root)
  return r === '/' || r === '' || (!!home && r === norm(home))
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
    // A home-folder or "/" cwd: no write is low risk.
    if (WORKSPACE_WRITE_TOOLS.has(toolName) && workspaceRoot !== undefined && isBroadRoot(workspaceRoot)) return 'high'
    const target = targetPath(input)
    if (target === undefined && DEFAULTS_TO_CWD.has(toolName)) return 'low'
    return isInWorkspace(target, workspaceRoot) && !isSensitivePath(target) ? 'low' : 'high'
  }
  // Bash/KillShell (shell side effects), WebFetch/WebSearch (network/exfil),
  // Task (spawns an agent that can do anything), MCP tools (mcp__*), and every
  // unknown tool fall through to HIGH — never auto-approved.
  return 'high'
}
