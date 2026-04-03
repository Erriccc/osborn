/**
 * claude-auth.ts — Claude Code CLI OAuth flow
 *
 * Handles first-time authentication for Claude Code in a headless/cloud environment.
 *
 * Flow:
 *   1. Check if ~/.claude/.credentials.json exists and is valid
 *   2. If not, spawn `claude auth login` via node-pty
 *   3. Capture the OAuth URL from stdout
 *   4. Send URL to frontend via callback (WebSocket data channel)
 *   5. Watch for "Login successful" → send auth_complete to frontend
 *   6. Agent startup proceeds once authenticated
 */

import * as pty from 'node-pty'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ─────────────────────────────────────────
// Constants
// ─────────────────────────────────────────

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')

// Matches the OAuth URL Claude CLI prints to stdout (claude.ai or claude.com)
const URL_PATTERN = /https:\/\/[^\s\x1B\r\n]*oauth\/authorize[^\s\x1B\r\n]*/

// Matches successful login confirmation (various Claude CLI versions)
const SUCCESS_PATTERN = /Login successful|Logged in as|Successfully authenticated|authenticated as|auth.*success/i

// How long to wait for auth before timing out (5 minutes)
const AUTH_TIMEOUT_MS = 5 * 60 * 1000

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface ClaudeAuthCallbacks {
  /** Called when the OAuth URL is captured — send this to the frontend */
  onUrl: (url: string) => void
  /** Called when the CLI is waiting for the auth code paste */
  onWaitingForCode: () => void
  /** Called when login completes successfully */
  onComplete: () => void
  /** Called on error or timeout */
  onError: (message: string) => void
  /** Optional: called for raw terminal output (for debugging) */
  onOutput?: (text: string) => void
}

export interface ClaudeAuthHandle {
  /** Write the OAuth code to the CLI's stdin */
  submitCode: (code: string) => void
}

// ─────────────────────────────────────────
// Auth Check
// ─────────────────────────────────────────

/**
 * Returns true if Claude credentials exist and the access token is not expired.
 */
export function isClaudeAuthenticated(): boolean {
  if (!existsSync(CREDENTIALS_PATH)) return false

  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8')
    const creds = JSON.parse(raw)
    const oauth = creds?.claudeAiOauth

    if (!oauth?.accessToken) return false

    // Check expiry — give a 60s buffer for clock skew
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
 * Check auth status via `claude auth status` — more reliable than file parsing.
 * Uses execSync instead of node-pty to avoid posix_spawnp PATH issues on macOS with NVM.
 * Returns true if logged in, false otherwise.
 */
export async function checkClaudeAuthStatus(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process')
    const output = execSync('claude auth status', {
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env },
    })
    // CLI outputs JSON with "loggedIn": true/false
    if (output.includes('"loggedIn": true') || output.includes('"loggedIn":true')) {
      return true
    }
    return /logged in|authenticated|active/i.test(output)
  } catch {
    return false
  }
}

// ─────────────────────────────────────────
// Auth Flow
// ─────────────────────────────────────────

/**
 * Run the Claude CLI OAuth flow in a pseudo-terminal.
 * Captures the login URL and sends it via callbacks.
 * Returns a handle to submit the auth code back to the CLI.
 *
 * Flow:
 *   1. CLI prints OAuth URL → onUrl callback
 *   2. User opens URL, logs in, gets auth code
 *   3. Frontend sends code → submitCode() writes to pty stdin
 *   4. CLI validates → onComplete callback
 *
 * Uses `claude auth login --claudeai` to trigger the OAuth flow.
 */
export function runClaudeAuthFlow(callbacks: ClaudeAuthCallbacks): { handle: ClaudeAuthHandle; done: Promise<void> } {
  let procRef: ReturnType<typeof pty.spawn> | null = null

  const handle: ClaudeAuthHandle = {
    submitCode: (code: string) => {
      if (procRef) {
        const trimmed = code.trim()
        console.log(`🔑 Submitting auth code to Claude CLI (${trimmed.length} chars)`)
        // Claude CLI uses Ink (React terminal UI) which reads raw keypresses, not line-buffered stdin.
        // Write chars in small chunks to simulate real typing, then send Enter.
        const CHUNK_SIZE = 10
        let offset = 0
        const writeChunk = () => {
          if (!procRef || offset >= trimmed.length) {
            // All chars written — send Enter
            if (procRef) {
              console.log('🔑 Auth code fully written, sending Enter')
              procRef.write('\r')
            }
            return
          }
          const chunk = trimmed.slice(offset, offset + CHUNK_SIZE)
          procRef.write(chunk)
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
    console.log('🔑 Starting Claude Code authentication flow...')

    // setup-token provides Ink UI with "Paste code here if prompted >" input
    // Unlike `auth login` which ignores pty stdin, setup-token reads input correctly
    const proc = pty.spawn('claude', ['setup-token'], {
      name: 'xterm-color',
      cols: 500,  // Wide enough to prevent Ink from wrapping the OAuth URL
      rows: 30,
      cwd: homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-color',
      },
    })
    procRef = proc

    let buffer = ''
    let urlSent = false
    let codeSolicited = false
    let completed = false

    // Timeout guard
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
      // Strip ANSI escape codes for pattern matching
      const clean = data.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
                        .replace(/\x1B\][^\x07]*\x07/g, '')
      buffer += clean

      // Log all CLI output for debugging auth flow
      console.log(`🔑 [claude-cli] ${clean.trim().substring(0, 200)}`)

      // Forward raw output for debugging if requested
      callbacks.onOutput?.(data)

      // Detect OAuth URL (only send once)
      if (!urlSent) {
        const urlMatch = buffer.match(URL_PATTERN)
        if (urlMatch) {
          const url = urlMatch[0].trim()
          console.log(`🔗 Claude auth URL captured (${url.length} chars)`)
          urlSent = true
          callbacks.onUrl(url)
          buffer = ''
        }
      }

      // Detect when CLI is waiting for the auth code paste
      // Claude CLI prompts: "Paste code:" or "Enter code:" or just waits for input after URL
      if (urlSent && !codeSolicited && /paste|enter.*code|authentication code/i.test(buffer)) {
        codeSolicited = true
        console.log('🔑 Claude CLI waiting for auth code')
        callbacks.onWaitingForCode()
        buffer = ''
      }

      // Detect successful login
      if (!completed && SUCCESS_PATTERN.test(buffer)) {
        completed = true
        clearTimeout(timeout)
        procRef = null
        console.log('✅ Claude authentication complete')
        callbacks.onComplete()
        proc.kill()
        resolve()
      }

      // Detect OAuth error (invalid code, expired, etc.)
      if (/OAuth error|Invalid code|expired/i.test(buffer)) {
        console.log('⚠️ Claude auth error detected in CLI output')
        callbacks.onError(buffer.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').trim().substring(0, 200))
        buffer = ''
      }
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
 * If already authenticated, returns immediately.
 * If not, runs the OAuth flow and waits for completion.
 *
 * @param sendToFrontend - function to send WebSocket data messages to the frontend
 */
export async function ensureClaudeAuth(
  sendToFrontend: (type: string, payload: unknown) => void
): Promise<{ submitCode?: (code: string) => void; done?: Promise<void> }> {
  // Quick file-based check first
  if (isClaudeAuthenticated()) {
    console.log('✅ Claude already authenticated (credentials file valid)')
    return {}
  }

  // Deeper check via CLI status command
  const cliStatus = await checkClaudeAuthStatus()
  if (cliStatus) {
    console.log('✅ Claude already authenticated (CLI status confirmed)')
    return {}
  }

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
    onOutput: (text) => {
      // Uncomment for terminal output streaming to frontend:
      // sendToFrontend('claude_auth_output', { text })
    },
  })

  // Return handle immediately so index.ts can wire up the code submission
  // The `done` promise resolves when auth completes
  // Don't await here — let index.ts handle both the handle and the promise
  return { submitCode: handle.submitCode, done }
}
