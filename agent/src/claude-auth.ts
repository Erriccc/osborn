/**
 * claude-auth.ts — Claude Code CLI OAuth flow
 *
 * Handles authentication for Claude Code in headless/cloud environments.
 * Learned from claudebox (etokarev/claude-code-docker, vutran1710/claudebox).
 *
 * Auth priority:
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var (set via `claude setup-token` on local machine)
 *   2. ~/.claude/.credentials.json file (persisted on Fly.io volume)
 *   3. `claude auth status --json` CLI check
 *   4. Interactive OAuth flow via `claude setup-token` + pty
 *
 * On Linux/Docker, credentials go to ~/.claude/.credentials.json (file-based, no keyring).
 * The Fly.io volume at /workspace/.claude is symlinked to ~/.claude for persistence.
 */

import * as pty from 'node-pty'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Resolve the full path to the `claude` binary.
 * node-pty uses posix_spawnp which may not find binaries in nvm/homebrew paths.
 * Shell-based `which` resolves the full PATH including .zshrc/.bashrc additions.
 * Also checks Docker/Linux global npm paths for Fly.io/container deployments.
 */
let _cachedClaudePath: string | null = null
function resolveClaudePath(): string {
  if (_cachedClaudePath) return _cachedClaudePath

  // 1. Shell-based resolution — picks up nvm, homebrew, etc.
  try {
    const resolved = execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim()
    if (resolved && existsSync(resolved)) {
      _cachedClaudePath = resolved
      return resolved
    }
  } catch {}

  // 2. Fallback: check common locations (macOS, Linux, Docker, nvm)
  const candidates = [
    // Linux / Docker / Fly.io (npm install -g @anthropic-ai/claude-code)
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    // macOS Homebrew (Apple Silicon)
    '/opt/homebrew/bin/claude',
    // nvm (current node version — macOS/Linux)
    join(homedir(), '.nvm/versions/node', process.version, 'bin/claude'),
    // macOS Homebrew cask (Intel)
    '/usr/local/Caskroom/claude-code/latest/claude',
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      console.log(`🔑 Found claude at: ${p}`)
      _cachedClaudePath = p
      return p
    }
  }

  // 3. Try npm global bin directory (covers custom npm prefix, Docker variants)
  try {
    const npmBin = execSync('npm bin -g', { encoding: 'utf-8', timeout: 5000 }).trim()
    const npmClaudePath = join(npmBin, 'claude')
    if (existsSync(npmClaudePath)) {
      console.log(`🔑 Found claude at: ${npmClaudePath} (via npm bin -g)`)
      _cachedClaudePath = npmClaudePath
      return npmClaudePath
    }
  } catch {}

  console.warn('⚠️ Could not resolve claude binary path — falling back to "claude"')
  return 'claude' // last resort — let posix_spawnp try
}

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')

/**
 * Strip ALL ANSI escape sequences from a string — CSI (including private
 * prefixes like `?`), OSC (both BEL and ST terminators), and lone ESC bytes.
 *
 * This is a superset of the common `/\x1B\[[0-9;]*[A-Za-z]/g` pattern, which
 * misses private-prefix modes like `\x1B[?2026h` and string terminators like
 * `\x1B\\`. Claude's Ink UI uses these extensively and they leak into error
 * messages and URLs when we only strip the basic CSI form.
 */
function stripAnsi(text: string): string {
  return text
    // Full CSI: ESC [ <intermediates 0x20–0x3F> <final 0x40–0x7E>
    .replace(/\x1B\[[\x20-\x3F]*[\x40-\x7E]/g, '')
    // OSC terminated by BEL (0x07) — ESC ] <content> BEL
    .replace(/\x1B\][^\x07]*\x07/g, '')
    // OSC terminated by ST (ESC \) — ESC ] <content> ESC \
    .replace(/\x1B\][^\x1B]*\x1B\\/g, '')
    // Any remaining lone ESC bytes (e.g. ESC \ string terminator used standalone)
    .replace(/\x1B/g, '')
}

// URL matching: strip all whitespace first (like claudebox), then match
// Handles Ink UI wrapping URLs across multiple lines
const URL_REGEX = /https:\/\/claude\.(com|ai)\/cai\/oauth\/authorize[^\s]*/

// Matches successful login/token creation
const SUCCESS_PATTERN = /Long-lived authentication token created|Login successful|Logged in as|Successfully authenticated|auth.*success/i

// How long to wait for auth before timing out (5 minutes)
const AUTH_TIMEOUT_MS = 5 * 60 * 1000

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface ClaudeAuthCallbacks {
  onUrl: (url: string) => void
  onWaitingForCode: () => void
  onComplete: () => void
  onError: (message: string) => void
  onOutput?: (text: string) => void
}

export interface ClaudeAuthHandle {
  submitCode: (code: string) => void
}

// ─────────────────────────────────────────
// Auth Check
// ─────────────────────────────────────────

/**
 * Check if CLAUDE_CODE_OAUTH_TOKEN env var is set (highest priority).
 * This is the recommended approach for cloud deployments.
 * Token generated via `claude setup-token` on local machine.
 */
function hasOAuthTokenEnv(): boolean {
  return !!process.env.CLAUDE_CODE_OAUTH_TOKEN
}

/**
 * Check if credentials file exists with a valid access token.
 * On Linux/Docker, Claude Code stores OAuth creds at ~/.claude/.credentials.json
 */
export function isClaudeAuthenticated(): boolean {
  // Env var takes highest priority
  if (hasOAuthTokenEnv()) return true

  if (!existsSync(CREDENTIALS_PATH)) return false

  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8')
    const creds = JSON.parse(raw)
    const oauth = creds?.claudeAiOauth

    if (!oauth?.accessToken) return false

    // Check expiry with 60s buffer
    if (oauth.expiresAt && Date.now() > oauth.expiresAt - 60_000) {
      console.log('⚠️  Claude credentials exist but access token is expired')
      return false
    }

    return true
  } catch (err) {
    console.warn('⚠️  Failed to read Claude credentials:', err)
    return false
  }
}

/**
 * Check auth via `claude auth status` (most reliable).
 * Uses resolved path to avoid posix_spawnp PATH issues.
 */
export async function checkClaudeAuthStatus(): Promise<boolean> {
  try {
    const claudePath = resolveClaudePath()
    console.log(`🔑 Checking auth via: ${claudePath} auth status`)
    const output = execSync(`"${claudePath}" auth status`, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env },
    })
    if (output.includes('"loggedIn": true') || output.includes('"loggedIn":true')) {
      return true
    }
    return /logged in|authenticated|active/i.test(output)
  } catch {
    return false
  }
}

// ─────────────────────────────────────────
// URL Extraction (claudebox pattern)
// ─────────────────────────────────────────

/**
 * Extract OAuth URL from CLI output.
 *
 * Strips ALL whitespace first (like vutran1710/claudebox) to handle Ink UI
 * wrapping the URL across multiple lines. Cleans trailing junk the Ink UI
 * appends (e.g. "Pastecodehereifprompted") and any stray ESC bytes.
 *
 * Note on redirect_uri: we used to strip it hoping claude.ai would fall back
 * to an in-page code display, but claude.ai REQUIRES redirect_uri and returns
 * "Invalid OAuth Request: Missing redirect_uri parameter" when it's missing.
 * The pinned Claude Code client ID (9d1c250a-e61b-44d9-88ed-5944d1962f5e)
 * only has http://localhost:<port>/callback URIs in its whitelist, so we
 * can't rewrite to a public callback either — it would be rejected.
 *
 * Actual flow that works: keep the localhost redirect AS-IS. User clicks the
 * URL on any device, authorizes. claude.ai 302s the browser to the localhost
 * URL (which is unreachable). The browser shows "connection refused" but
 * leaves the full URL in the address bar — including ?code=XXX&state=YYY.
 * The user copies the `code` value from the address bar and pastes it into
 * the modal. This is ugly on mobile but it's the only flow the server
 * accepts.
 */
function extractOAuthUrl(text: string): string | null {
  // Replace ALL ANSI control sequences with a NUL sentinel. NUL (not a
  // space) because we strip all whitespace next to unwrap URLs that Ink
  // split across terminal lines — a space would vanish and text on either
  // side of a control sequence would fuse into the URL. NUL survives the
  // strip and acts as a hard boundary the tail-cut below can detect.
  //
  // Uses the same patterns as stripAnsi() but replaces with SENTINEL
  // instead of '' so boundaries are preserved.
  const SENTINEL = '\x00'
  const noAnsi = text
    .replace(/\x1B\[[\x20-\x3F]*[\x40-\x7E]/g, SENTINEL)  // Full CSI (incl. private-prefix ?/</>/=)
    .replace(/\x1B\][^\x07]*\x07/g, SENTINEL)              // OSC terminated by BEL
    .replace(/\x1B\][^\x1B]*\x1B\\/g, SENTINEL)            // OSC terminated by ST (ESC \)
    .replace(/\x1B/g, SENTINEL)                             // Lone ESC bytes
  // Strip all whitespace (claudebox pattern: strings.Join(strings.Fields(pane), ""))
  // to unwrap URLs split across terminal lines. NUL sentinels survive.
  const stripped = noAnsi.replace(/\s+/g, '')

  const match = stripped.match(URL_REGEX)
  if (!match) return null

  let url = match[0]

  // Cut at the first NUL sentinel — that marks where an ANSI control code
  // USED to be, which is a reliable boundary between the URL and adjacent
  // terminal output that got fused by the whitespace strip.
  const sentinelCut = url.indexOf(SENTINEL)
  if (sentinelCut > 0) url = url.substring(0, sentinelCut)

  // Cut at the first `paste` (case-insensitive) — Ink always appends a
  // "Paste code here if prompted" input box after the URL, and any case
  // variant of it is junk. None of Claude's query-param values begin
  // with "paste" so this is safe.
  const pasteCut = url.toLowerCase().indexOf('paste')
  if (pasteCut > 0) url = url.substring(0, pasteCut)

  // Defensive: cut at any byte outside the URL-valid character set. OAuth
  // URLs use letters, digits, `%`, and URL-safe punctuation only.
  const tailCut = url.search(/[^A-Za-z0-9%._~:/?#\[\]@!$&'()*+,;=\-]/)
  if (tailCut > 0) url = url.substring(0, tailCut)

  return url
}

// ─────────────────────────────────────────
// Auth Flow
// ─────────────────────────────────────────

/**
 * Run the Claude CLI OAuth flow via `claude setup-token` in a pseudo-terminal.
 *
 * setup-token provides the Ink UI with a "Paste code here if prompted >" input.
 * Unlike `auth login` which ignores pty stdin, setup-token accepts typed input.
 *
 * Code is written in chunks to simulate real typing (Ink reads raw keypresses).
 */
export function runClaudeAuthFlow(callbacks: ClaudeAuthCallbacks): { handle: ClaudeAuthHandle; done: Promise<void> } {
  let procRef: ReturnType<typeof pty.spawn> | null = null

  const handle: ClaudeAuthHandle = {
    submitCode: (code: string) => {
      if (procRef) {
        let trimmed = code.trim()
        // User may paste the full callback URL instead of just the code:
        //   http://localhost:38719/callback?code=ZIgFd5nApQMR7...&state=TSLp6...
        // Extract the bare `code` value so the CLI accepts it.
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          try {
            const u = new URL(trimmed)
            const extracted = u.searchParams.get('code')
            if (extracted) {
              console.log(`🔑 Extracted code from pasted callback URL (${extracted.length} chars)`)
              trimmed = extracted
            }
          } catch {
            // Not a valid URL, use as-is
          }
        }
        console.log(`🔑 Submitting auth code to Claude CLI (${trimmed.length} chars)`)
        // Ink reads raw keypresses. Write in chunks to simulate typing.
        const CHUNK_SIZE = 10
        let offset = 0
        const writeChunk = () => {
          if (!procRef || offset >= trimmed.length) {
            if (procRef) {
              console.log('🔑 Auth code fully written, sending Enter')
              procRef.write('\r')
            }
            return
          }
          procRef.write(trimmed.slice(offset, offset + CHUNK_SIZE))
          offset += CHUNK_SIZE
          setTimeout(writeChunk, 50)
        }
        writeChunk()
      } else {
        console.error('❌ Cannot submit code — Claude CLI process not running')
      }
    },
  }

  const done = new Promise<void>((resolve, reject) => {
    const claudePath = resolveClaudePath()
    console.log(`🔑 Starting Claude Code authentication flow: ${claudePath} setup-token`)

    const proc = pty.spawn(claudePath, ['setup-token'], {
      name: 'xterm-color',
      cols: 500,  // Wide to prevent Ink URL wrapping
      rows: 30,
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-color' },
    })
    procRef = proc

    let fullBuffer = ''  // Accumulates ALL output for URL extraction
    let recentBuffer = '' // Recent output for pattern matching
    let urlSent = false
    let codeSolicited = false
    let completed = false

    const timeout = setTimeout(() => {
      if (!completed) {
        proc.kill()
        procRef = null
        const msg = 'Claude authentication timed out after 5 minutes'
        console.error('❌', msg)
        callbacks.onError(msg)
        reject(new Error(msg))
      }
    }, AUTH_TIMEOUT_MS)

    proc.onData((data: string) => {
      const clean = stripAnsi(data)
                        .replace(/\x1B\][^\x07]*\x07/g, '')
      fullBuffer += clean
      recentBuffer += clean

      // Debug log (truncated)
      const logLine = clean.trim()
      if (logLine) console.log(`🔑 [claude-cli] ${logLine.substring(0, 200)}`)

      callbacks.onOutput?.(data)

      // Extract OAuth URL from accumulated output (claudebox whitespace-strip pattern)
      if (!urlSent) {
        const url = extractOAuthUrl(fullBuffer)
        if (url && url.length > 100) {  // Valid URLs are >100 chars
          console.log(`🔗 Claude auth URL captured (${url.length} chars)`)
          urlSent = true
          callbacks.onUrl(url)
          recentBuffer = ''
        }
      }

      // Detect code prompt
      if (urlSent && !codeSolicited && /paste|enter.*code|Paste code/i.test(recentBuffer)) {
        codeSolicited = true
        console.log('🔑 Claude CLI waiting for auth code')
        callbacks.onWaitingForCode()
        recentBuffer = ''
      }

      // Detect the OAuth token in output (sk-ant-oat01-...)
      // setup-token prints it AFTER "created successfully!" — we must NOT kill before capturing it
      const tokenMatch = fullBuffer.match(/sk-ant-oat01-[A-Za-z0-9_-]+/)
      if (tokenMatch && !completed) {
        completed = true
        clearTimeout(timeout)
        const token = tokenMatch[0]
        console.log(`✅ OAuth token captured (${token.length} chars, starts with ${token.substring(0, 20)}...)`)

        // Set as env var so Claude Agent SDK picks it up immediately
        process.env.CLAUDE_CODE_OAUTH_TOKEN = token

        // Persist to volume for future restarts
        try {
          const tokenDir = join(homedir(), '.claude')
          mkdirSync(tokenDir, { recursive: true })
          // Write as credentials file
          writeFileSync(CREDENTIALS_PATH, JSON.stringify({
            claudeAiOauth: { accessToken: token }
          }), { mode: 0o600 })
          // Also write token to a simple file for easy env var restore on restart
          writeFileSync(join(tokenDir, '.oauth-token'), token, { mode: 0o600 })
          console.log('✅ Token persisted to volume')
        } catch (err) {
          console.warn('⚠️ Failed to persist token to file:', err)
        }

        procRef = null
        callbacks.onComplete()
        proc.kill()
        resolve()
      }

      // Detect errors
      if (/OAuth error|Invalid code|expired/i.test(recentBuffer)) {
        const errMsg = stripAnsi(recentBuffer).trim().substring(0, 200)
        console.log('⚠️ Claude auth error:', errMsg)
        callbacks.onError(errMsg)
        recentBuffer = ''
      }

      // Keep recentBuffer from growing unbounded
      if (recentBuffer.length > 5000) recentBuffer = recentBuffer.slice(-2000)
    })

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      clearTimeout(timeout)
      procRef = null
      if (!completed) {
        const msg = `Claude CLI exited with code ${exitCode} before auth completed`
        console.error('❌', msg)
        callbacks.onError(msg)
        reject(new Error(msg))
      }
    })
  })

  return { handle, done }
}

// ─────────────────────────────────────────
// Startup Gate
// ─────────────────────────────────────────

// Module-level state: tracks the in-flight auth flow (if any) so that
// concurrent callers from e.g. fast LiveKit reconnects don't each spawn
// their own `claude setup-token` pty. Every call after the first returns
// the SAME submitCode handle and done promise, and the SAME URL is
// replayed to the new sendToFrontend callback.
interface InFlightAuth {
  submitCode: (code: string) => void
  done: Promise<void>
  lastUrl: string | null
  lastStatus: 'waiting' | 'waiting_code' | null
  subscribers: Array<(type: string, payload: unknown) => void>
}
let inFlightAuth: InFlightAuth | null = null

/**
 * Ensure Claude is authenticated before proceeding.
 *
 * Check order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var
 *   2. ~/.claude/.credentials.json file
 *   3. `claude auth status --json`
 *   4. Interactive OAuth flow (setup-token)
 *
 * Concurrency: if a previous call is still running its OAuth flow, new
 * callers attach to the existing flow rather than spawning a second pty.
 * This prevents the situation where LiveKit reconnects (e.g. after a
 * microphone-permission error) retrigger ensureClaudeAuth and the user
 * sees two different URLs / two different code_challenges racing.
 */
export async function ensureClaudeAuth(
  sendToFrontend: (type: string, payload: unknown) => void
): Promise<{ submitCode?: (code: string) => void; done?: Promise<void> }> {
  // If an auth flow is already running, attach to it and replay any
  // state we've already captured (the URL, any waiting_code prompt).
  if (inFlightAuth) {
    console.log('🔑 ensureClaudeAuth called while a flow is in-flight — attaching new subscriber')
    inFlightAuth.subscribers.push(sendToFrontend)
    // Replay the state the frontend needs to render the modal correctly.
    sendToFrontend('claude_auth_required', {
      message: 'Claude authentication required. A login URL will appear shortly.',
    })
    if (inFlightAuth.lastUrl) {
      sendToFrontend('claude_auth_url', { url: inFlightAuth.lastUrl })
    }
    if (inFlightAuth.lastStatus === 'waiting_code') {
      sendToFrontend('claude_auth_waiting_code', {
        message: 'Paste the authentication code from the browser.',
      })
    }
    return { submitCode: inFlightAuth.submitCode, done: inFlightAuth.done }
  }

  // Check 0: Restore token from volume if previously persisted
  if (!hasOAuthTokenEnv()) {
    try {
      const tokenFile = join(homedir(), '.claude', '.oauth-token')
      if (existsSync(tokenFile)) {
        const token = readFileSync(tokenFile, 'utf-8').trim()
        if (token.startsWith('sk-ant-')) {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = token
          console.log('✅ Restored CLAUDE_CODE_OAUTH_TOKEN from persisted volume')
        }
      }
    } catch {}
  }

  // Check 1: Env var (cloud best practice — set via Fly secrets or persisted from setup-token)
  if (hasOAuthTokenEnv()) {
    console.log('✅ Claude authenticated via CLAUDE_CODE_OAUTH_TOKEN env var')
    return {}
  }

  // Check 2: Credentials file
  if (isClaudeAuthenticated()) {
    console.log('✅ Claude authenticated via credentials file')
    return {}
  }

  // Check 3: CLI status (handles Keychain on macOS, other storage backends)
  const cliStatus = await checkClaudeAuthStatus()
  if (cliStatus) {
    console.log('✅ Claude authenticated (CLI status confirmed)')
    return {}
  }

  // Check 4: Need interactive OAuth flow
  console.log('🔑 Claude not authenticated — starting OAuth flow')

  // Create the in-flight record BEFORE spawning, and fan-out every
  // callback to all current subscribers. New subscribers that attach
  // later get replay of lastUrl / lastStatus from the deduped path
  // at the top of this function.
  const subscribers: Array<(type: string, payload: unknown) => void> = [sendToFrontend]
  const fanout = (type: string, payload: unknown) => {
    for (const sub of subscribers) {
      try { sub(type, payload) } catch (err) { console.warn('🔑 subscriber failed:', err) }
    }
  }

  fanout('claude_auth_required', {
    message: 'Claude authentication required. A login URL will appear shortly.',
  })

  const { handle, done } = runClaudeAuthFlow({
    onUrl: (url) => {
      console.log(`📤 Sending Claude auth URL to frontend (${url.length} chars)`)
      if (inFlightAuth) {
        inFlightAuth.lastUrl = url
        inFlightAuth.lastStatus = 'waiting'
      }
      fanout('claude_auth_url', { url })
    },
    onWaitingForCode: () => {
      console.log('📤 Sending code prompt to frontend')
      if (inFlightAuth) inFlightAuth.lastStatus = 'waiting_code'
      fanout('claude_auth_waiting_code', {
        message: 'Paste the authentication code from the browser.',
      })
    },
    onComplete: () => {
      // Include the captured token so the frontend can persist it to the
      // host-persistent layer via the Sprites API. Without this, credentials
      // written inside the service container's ephemeral overlay are lost on
      // every warm→running transition (service re-registration creates a
      // fresh container).
      fanout('claude_auth_complete', {
        message: 'Claude authenticated successfully. Starting voice session...',
        token: process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
      })
    },
    onError: (message) => {
      fanout('claude_auth_error', { message })
    },
  })

  // Publish the in-flight record so concurrent callers attach to it.
  inFlightAuth = {
    submitCode: handle.submitCode,
    done,
    lastUrl: null,
    lastStatus: null,
    subscribers,
  }

  // Clear the in-flight record once the flow settles, success or failure.
  done.finally(() => {
    console.log('🔑 OAuth flow settled — clearing in-flight guard')
    inFlightAuth = null
  })

  return { submitCode: handle.submitCode, done }
}
