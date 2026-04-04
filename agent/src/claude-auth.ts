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
import { homedir } from 'os'
import { join } from 'path'

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')

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
 * Check auth via `claude auth status --json` (most reliable).
 * Uses execSync to avoid node-pty PATH issues on macOS.
 */
export async function checkClaudeAuthStatus(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process')
    const output = execSync('claude auth status', {
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
 * Strips ALL whitespace first (like vutran1710/claudebox) to handle
 * Ink UI wrapping the URL across multiple lines.
 * Also cleans trailing "Pastecodehereifprompted" that Ink appends.
 */
function extractOAuthUrl(text: string): string | null {
  // Strip ANSI codes
  const noAnsi = text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
                     .replace(/\x1B\][^\x07]*\x07/g, '')
  // Strip all whitespace (claudebox pattern: strings.Join(strings.Fields(pane), ""))
  const stripped = noAnsi.replace(/\s+/g, '')

  const match = stripped.match(URL_REGEX)
  if (!match) return null

  let url = match[0]
  // Clean trailing Ink artifacts (claudebox pattern)
  const trailingJunk = ['Pastecodehereifprompted', 'Pastecodehereifprompted>']
  for (const junk of trailingJunk) {
    const idx = url.indexOf(junk)
    if (idx > 0) url = url.substring(0, idx)
  }

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
        const trimmed = code.trim()
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
    console.log('🔑 Starting Claude Code authentication flow (setup-token)...')

    const proc = pty.spawn('claude', ['setup-token'], {
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
      const clean = data.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
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
        const errMsg = recentBuffer.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim().substring(0, 200)
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

/**
 * Ensure Claude is authenticated before proceeding.
 *
 * Check order:
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var
 *   2. ~/.claude/.credentials.json file
 *   3. `claude auth status --json`
 *   4. Interactive OAuth flow (setup-token)
 */
export async function ensureClaudeAuth(
  sendToFrontend: (type: string, payload: unknown) => void
): Promise<{ submitCode?: (code: string) => void; done?: Promise<void> }> {
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
  sendToFrontend('claude_auth_required', {
    message: 'Claude authentication required. A login URL will appear shortly.',
  })

  const { handle, done } = runClaudeAuthFlow({
    onUrl: (url) => {
      console.log('📤 Sending Claude auth URL to frontend')
      sendToFrontend('claude_auth_url', { url })
    },
    onWaitingForCode: () => {
      console.log('📤 Sending code prompt to frontend')
      sendToFrontend('claude_auth_waiting_code', {
        message: 'Paste the authentication code from the browser.',
      })
    },
    onComplete: () => {
      sendToFrontend('claude_auth_complete', {
        message: 'Claude authenticated successfully. Starting voice session...',
      })
    },
    onError: (message) => {
      sendToFrontend('claude_auth_error', { message })
    },
  })

  return { submitCode: handle.submitCode, done }
}
