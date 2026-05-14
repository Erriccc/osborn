// Load environment variables FIRST before any other imports
import 'dotenv/config'

import { voice, initializeLogger, type Agent } from '@livekit/agents'
import { CloudTurnDetector } from './turn-detector-shim.js'
import { Room, RoomEvent, RemoteParticipant, LocalParticipant } from '@livekit/rtc-node'
import { AccessToken } from 'livekit-server-sdk'

// Initialize logger before anything else
initializeLogger({ pretty: true, level: 'info' })

// Prevent MaxListenersExceededWarning on AbortSignal from Claude SDK query() calls
// Each resumed query() adds listeners to the shared signal; default limit is 10
import { setMaxListeners } from 'node:events'
setMaxListeners(50)

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, cpSync, rmSync, renameSync, statSync, createWriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { createGunzip } from 'node:zlib'

// Resolve __dirname for this ESM module so we can find sibling files (e.g.
// meeting-output.html) relative to the compiled JS location, NOT process.cwd().
// In production cwd is the user's workspace; the static file lives next to dist/index.js.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { createPatch } from 'diff'
import { loadConfig, getMcpServers, getEnabledMcpServerNames, getVoiceMode, getRealtimeConfig, getDirectConfig, listSessions, listAllClaudeSessions, getMostRecentSessionId, sessionExists, cleanupOrphanedMetadata, getSessionSummary, getConversationHistory, ensureSessionWorkspace, getSessionWorkspace, getMcpServerStatusList, buildMcpServersForKeys, listWorkspaceArtifacts, listLibraryFiles, type VoiceMode, type SessionInfo, type SessionSummary, type ConversationExchange } from './config.js'
import { createSTT, createTTS, createRealtimeModelFromConfig, DIRECT_MODE_STT, DIRECT_MODE_TTS } from './voice-io.js'
import { createClaudeLLM } from './claude-llm.js'
import { clearPipelineFastBrainSession, prewarmBM25Index } from './pipeline-fastbrain.js'
import { ensureClaudeAuth } from './claude-auth.js'
import { createSmitheryProxy, destroySmitheryProxy, parseSmitheryUrl, isSmitheryUrl, SmitheryAuthorizationError } from './smithery-proxy.js'
import { askHaiku, askFastBrain, updateSpecFromJSONL, processResearchCompletion, handleResearchBatch, prepareBriefingScript, prepareRecoveryScript, writeQuestionToSpec, checkOutputAgainstQuestions, generateProactivePrompt, clearFastBrainSession, type ConversationTurn, type FastBrainCallbacks } from './fast-brain.js'
import { DIRECT_MODE_PROMPT, getRealtimeInstructions, getScriptInjection, getProactiveInjection, getNotificationInjection, getResearchCompleteInjection, getResearchUpdateInjection } from './prompts.js'
import { MCP_CATALOG } from './config.js'
import { getRecallClient } from './recall-client.js'
import { llm } from '@livekit/agents'
import { z } from 'zod'

// ============================================================
// DUAL MODE VOICE ARCHITECTURE
// ============================================================
// DIRECT MODE (default): STT → Claude Agent SDK → TTS
//   - Full coding capabilities via Claude Agent SDK
//   - Permission system flows to frontend
//   - Best for actual coding tasks
//
// REALTIME MODE: OpenAI/Gemini native speech-to-speech
//   - Faster response, lower latency
//   - Voice LLM with tool calling (ask_agent, respond_permission)
//   - Routes tasks to Claude agents for execution
// ============================================================

// Load skills list with name + description for frontend display
function loadSkillsList(agentDir: string): { name: string; description: string }[] {
  const skillsDir = join(agentDir, '.claude', 'skills')
  if (!existsSync(skillsDir)) return []
  const skills: { name: string; description: string }[] = []
  try {
    for (const skillName of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        const content = readFileSync(skillFile, 'utf-8')
        // Extract title from first # heading, or use folder name
        const titleMatch = content.match(/^#\s+(?:Skill:\s*)?(.+)/m)
        const name = titleMatch ? titleMatch[1].trim() : skillName
        // Extract description from first paragraph after heading
        const descMatch = content.match(/^#[^\n]+\n+([^\n#]+)/m)
        const description = descMatch ? descMatch[1].trim() : ''
        skills.push({ name, description })
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load skills list:', err)
  }
  return skills
}

// Generate a short, user-friendly room code
function generateRoomCode(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

// Parse CLI arguments
function parseArgs(): { roomCode?: string } {
  const args = process.argv.slice(2)
  let roomCode: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--room' && args[i + 1]) {
      roomCode = args[i + 1]
    }
    // Short code detection (e.g., `npm run dev abc123`)
    if (!args[i].startsWith('-') && args[i].length >= 4 && args[i].length <= 10 &&
        !['dev', 'start'].includes(args[i])) {
      roomCode = args[i]
    }
  }

  return { roomCode }
}

// Global error handlers
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason)
  if (msg.includes('aborted') || msg.includes('AbortError')) {
    console.log('⚠️ LLM request aborted (user interrupted)')
    return
  }
  // Gemini plugin intentionally supersedes generate_reply calls — safe to suppress
  if (msg.includes('Superseded')) {
    console.log('⚠️ generateReply superseded (expected during concurrent injections)')
    return
  }
  // OpenAI race: voice queue fired while server-side VAD already created a response
  if (msg.includes('conversation_already_has_active_response') || msg.includes('active_response')) {
    console.log('⚠️ OpenAI active response collision (will retry on next listening state)')
    return
  }
  // LiveKit SDK internal error after participant disconnect — safe to suppress
  if (msg.includes("reading 'source'") || msg.includes("reading 'type'")) {
    console.log('⚠️ Post-disconnect cleanup error (harmless)')
    return
  }
  // generateReply timeout — realtime LLM called a tool instead of speaking (toolChoice:'none' ignored)
  // or Superseded — new generateReply cancelled a pending one
  if (msg.includes('generateReply timed out') || msg.includes('generation_created') || msg.includes('Superseded')) {
    console.log('⚠️ generateReply failed:', msg.substring(0, 80))
    return
  }
  // AdaptiveInterruptionDetector crash — LiveKit Cloud returns string instead of JSON.
  // SDK handles this internally (retries → VAD fallback). Suppress residual noise.
  if (msg.includes('interruption prediction') || msg.includes('AdaptiveInterruptionDetector')) {
    return
  }
  console.error('❌ Unhandled Rejection:', msg)
})

process.on('uncaughtException', (error) => {
  if (error.message?.includes('aborted') || error.message?.includes('AbortError')) {
    console.log('⚠️ Operation aborted')
    return
  }
  console.error('❌ Uncaught Exception:', error)
})

// ============================================================
// HTTP API SERVER - Exposes session data to cloud-deployed frontend
// ============================================================

// Module-level room code so the HTTP server can expose it via GET /room-code
let currentRoomCode: string | null = null

function startApiServer(workingDir: string, port: number): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for cloud frontend
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`)

    const syncToken = process.env.OSBORN_SYNC_TOKEN

    if (req.method === 'GET' && url.pathname === '/sessions') {
      try {
        const limit = parseInt(url.searchParams.get('limit') || '100', 10)
        const sessions = await listAllClaudeSessions(limit)
        const payload = {
          sessions: sessions.map(s => ({
            sessionId: s.sessionId,
            projectSlug: s.projectSlug,
            projectPath: s.projectPath,
            cwd: s.cwd,
            timestamp: s.timestamp.toISOString(),
            lastMessage: s.lastMessage,
            messageCount: s.messageCount,
            fileSize: s.fileSize,
          })),
          total: sessions.length,
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      } catch (err) {
        console.error('API /sessions error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessions: [], total: 0, error: 'Failed to list sessions' }))
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      // Include osborn version — primary signal used by machines.readInstalledOsbornVersion()
      // to detect which agent version is running. Without this the consumer falls back to
      // parsing the Docker image tag (e.g. ":latest" → rejected) and returns null, which
      // breaks the dashboard's version badge + the upgrade-needed comparison.
      // Read once at module load? No — package.json is small and resolveFromPackage() handles
      // both `dist/` (installed) and `src/` (local dev) layouts.
      let version: string | undefined
      try {
        // Walk up from this file's dirname to find package.json. Works whether running
        // from src/ (tsx local dev) or dist/ (compiled npm install).
        const { readFileSync } = await import('node:fs')
        const { join } = await import('node:path')
        for (const rel of ['../package.json', '../../package.json']) {
          try {
            const pkg = JSON.parse(readFileSync(join(__dirname, rel), 'utf8'))
            if (pkg.name === 'osborn' && pkg.version) { version = pkg.version; break }
          } catch { /* try next */ }
        }
      } catch { /* version optional */ }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', workingDir, version }))
      return
    }

    // POST /webhook/recall — Recall.ai real-time transcript webhooks
    if (req.method === 'POST' && url.pathname === '/webhook/recall') {
      // Respond 200 immediately — never block or Node delays next webhooks
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')

      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const payload = JSON.parse(body)
          const recall = getRecallClient()
          if (recall) recall.handleWebhook(payload)
        } catch (e) {
          console.error('Recall webhook parse error:', e)
        }
      })
      return
    }

    // GET /meeting-output — Output Media webpage for Recall.ai bot audio.
    //
    // The file lives next to this compiled JS (copied by the build script from
    // src/ to dist/). Resolve via __dirname rather than process.cwd() — in
    // production cwd is the user's workspace, NOT the osborn package directory.
    if (req.method === 'GET' && url.pathname === '/meeting-output') {
      // Try the package-relative path first (post-build location), then fall
      // back to source path for `tsx src/index.ts` dev runs.
      const candidates = [
        join(__dirname, 'meeting-output.html'),       // dist/ (production)
        join(__dirname, '..', 'src', 'meeting-output.html'),  // dev: dist/ → src/
        join(__dirname, '..', 'meeting-output.html'), // tsx run from src/
      ]
      let html: string | null = null
      let foundPath: string | null = null
      for (const p of candidates) {
        try {
          html = readFileSync(p, 'utf-8')
          foundPath = p
          break
        } catch {}
      }
      if (html) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(html)
      } else {
        console.warn(`[meeting-output] not found in any of: ${candidates.join(', ')}`)
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('meeting-output.html not found')
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/room-code') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ roomCode: currentRoomCode }))
      return
    }

    // POST /restart — graceful process restart (process manager will restart)
    if (req.method === 'POST' && url.pathname === '/restart') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: 'Agent restarting...' }))
      console.log('🔄 Restart requested via HTTP — exiting for process manager restart')
      setTimeout(() => process.exit(0), 150)
      return
    }

    // GET /events — Server-Sent Events heartbeat for cloud-sandbox keepalive.
    //
    // This endpoint is the single thing preventing Sprites' CRIU-based
    // hibernation from freezing osborn's Node.js event loop and dropping our
    // LiveKit WebSocket mid-session. Short HTTP pings don't work: Sprites'
    // warm state serves /health responses from a process snapshot without
    // actually resuming the event loop, so background timers (including
    // LiveKit heartbeats) stop firing after a few seconds. That causes the
    // LiveKit server to drop osborn's participant, delete the room, and
    // leave any future user joins stuck at "Connecting..." forever.
    //
    // An OPEN long-lived TCP connection keeps the sprite in 'running' state.
    // The frontend opens this endpoint on chat page mount and holds it open
    // for the entire voice session. While open, osborn's event loop ticks
    // continuously, LiveKit heartbeats fire, and the room stays alive.
    //
    // For local (non-cloud) dev, this endpoint is harmless — it just idles
    // on a client that may never connect. Zero cost when unused.
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // Disable proxy buffering (nginx-style) so each ping is flushed
        // through Sprites' reverse proxy immediately rather than batched.
        'X-Accel-Buffering': 'no',
      })
      res.write(`: sprite-keepalive connected at ${new Date().toISOString()}\n\n`)
      const heartbeat = setInterval(() => {
        try { res.write(`: ping ${Date.now()}\n\n`) } catch {}
      }, 10_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        console.log('[events] SSE client disconnected')
      })
      console.log('[events] SSE client connected')
      return
    }

    // GET /sessions/export — stream a gzipped tar of ~/.claude/projects/ to the client
    // Optional ?workDir= query param: if present, export only that project's slug folder.
    if (req.method === 'GET' && url.pathname === '/sessions/export') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }
      const claudeDir = join(homedir(), '.claude')
      const projectsDir = join(claudeDir, 'projects')
      const workDir = url.searchParams.get('workDir')
      if (!existsSync(projectsDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No sessions found' }))
        return
      }
      const tarArgs = ['-czf', '-', '-C', claudeDir, 'projects']
      void workDir  // workDir param accepted but full projects/ export is returned
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="claude-sessions.tar.gz"',
        'Access-Control-Allow-Origin': '*',
      })
      // Stream tar output directly to response
      const tar = spawn('tar', tarArgs)
      tar.stdout.pipe(res)
      tar.stderr.on('data', (d: Buffer) => console.error('[export]', d.toString()))
      tar.on('close', (code: number | null) => { if (code !== 0) res.destroy() })
      return
    }

    // GET /sessions/manifest — return mtime+size for all .jsonl files per slug (public, no auth)
    // Helper: merge an extracted tar directory into ~/.claude/projects/ with all 4 fixes:
    //   1. Skip macOS AppleDouble entries (`._*`) that bsdtar emits
    //   2. Apply slug remap when targetWorkDir is supplied (chunked path missed this)
    //   3. Rewrite embedded `cwd` field inside .jsonl entries during remap so
    //      Claude Code can resume the conversation in the destination workspace
    //   4. Merge into existing dest dirs instead of failing on rename collision
    const mergeExtractedIntoProjects = async (
      sourceDir: string,
      targetWorkDir: string | undefined,
    ): Promise<{ filesWritten: number, remapped: Record<string, string> }> => {
      const claudeDir = join(homedir(), '.claude')
      const projectsDir = join(claudeDir, 'projects')
      mkdirSync(projectsDir, { recursive: true })

      // The archive sometimes wraps content in a 'projects' subdir, sometimes not.
      const extractedProjects = join(sourceDir, 'projects')
      const effectiveSource = existsSync(extractedProjects) ? extractedProjects : sourceDir

      // Filter out AppleDouble (`._*`) entries that macOS bsdtar emits for
      // resource forks. These crash later steps if they collide with real dirs.
      const sourceSlugs = readdirSync(effectiveSource)
        .filter(s => !s.startsWith('._') && !s.startsWith('.DS_Store'))

      // Build remap table: source-slug → target-slug.
      // Only remaps slugs that differ from the target (no-op if already correct).
      const remapped: Record<string, string> = {}
      const targetSlug = targetWorkDir ? targetWorkDir.replace(/\//g, '-') : ''
      if (targetSlug) {
        for (const slug of sourceSlugs) {
          if (slug !== targetSlug) remapped[slug] = targetSlug
        }
      }

      // Slug → original cwd path (reverse of slug encoding):
      //   '-Users-newupgrade-Desktop-Developer-osborn' → '/Users/newupgrade/Desktop/Developer/osborn'
      // Claude Code's slug rule: replace all '/' with '-', so reverse is replace '-' with '/'.
      // Leading '-' becomes '/'. We don't try to recover '.' (Claude uses '--' for it, but
      // dot-prefixed dirs are uncommon and a best-effort rewrite is enough for resume).
      const slugToCwd = (slug: string): string => '/' + slug.replace(/^-/, '').replace(/-/g, '/')

      let filesWritten = 0

      for (const sourceSlug of sourceSlugs) {
        const effectiveSlug = remapped[sourceSlug] ?? sourceSlug
        const destSlug = join(projectsDir, effectiveSlug)
        mkdirSync(destSlug, { recursive: true })

        const sourceSlugPath = join(effectiveSource, sourceSlug)
        const sourceCwd = slugToCwd(sourceSlug)
        const destCwd = targetWorkDir ?? slugToCwd(effectiveSlug)
        const needsCwdRewrite = sourceCwd !== destCwd

        // Walk the source slug directory and copy files individually so we can:
        //   (a) skip AppleDouble per-file too (in case nested)
        //   (b) rewrite cwd inside .jsonl files when remapping across workspaces
        //   (c) merge into existing destination directories without renameSync collision
        //   (d) keep newer-by-mtime when both sides have the same file (the user's
        //       requested "overwrite based on timestamp" rule for bidirectional sync)
        const walkAndCopy = (src: string, dst: string): void => {
          const entries = readdirSync(src, { withFileTypes: true })
          for (const e of entries) {
            if (e.name.startsWith('._') || e.name === '.DS_Store') continue
            const sp = join(src, e.name)
            const dp = join(dst, e.name)
            if (e.isDirectory()) {
              mkdirSync(dp, { recursive: true })
              walkAndCopy(sp, dp)
            } else if (e.isFile()) {
              // mtime conflict resolution — when destination already has this file,
              // only overwrite when the source is strictly newer. Preserves work
              // done on the destination side when re-syncing in either direction.
              let shouldWrite = true
              try {
                const dstStat = statSync(dp)
                const srcStat = statSync(sp)
                if (dstStat.mtimeMs >= srcStat.mtimeMs) shouldWrite = false
              } catch { /* dst doesn't exist — write it */ }
              if (!shouldWrite) continue

              if (needsCwdRewrite && e.name.endsWith('.jsonl')) {
                // Read, rewrite "cwd" field, write. JSONL is line-delimited;
                // string match on `"cwd":"<sourceCwd>"` is precise enough.
                const content = readFileSync(sp, 'utf8')
                const find = `"cwd":"${sourceCwd}"`
                const replace = `"cwd":"${destCwd}"`
                const rewritten = content.split(find).join(replace)
                writeFileSync(dp, rewritten)
              } else {
                cpSync(sp, dp, { force: true })
              }
              filesWritten++
            }
            // skip symlinks, sockets, etc.
          }
        }

        walkAndCopy(sourceSlugPath, destSlug)

        // Best-effort: ensure the resolved workspace directory exists so Claude
        // can resume conversations whose JSONLs reference it.
        const recoveredPath = effectiveSlug.replace(/^-/, '/').replace(/--/g, '/.').replace(/-/g, '/')
        if (recoveredPath && recoveredPath !== '/') {
          try { mkdirSync(recoveredPath, { recursive: true }) } catch { /* ignore */ }
        }
      }

      return { filesWritten, remapped }
    }

    if (req.method === 'GET' && url.pathname === '/sessions/manifest') {
      // Walks the FULL tree per slug — including sub-agent transcripts
      // (<slug>/<sessionId>/subagents/*.jsonl), tool-results (<slug>/<sessionId>/tool-results/*),
      // osb workspace files (<slug>/osb/<sessionId>/*), and file-history. Files are
      // keyed by their path RELATIVE to the slug dir so the client can preserve
      // structure when computing diffs. mtime is in ms epoch so a simple `>`
      // comparison is the "newer wins" merge rule.
      //
      // Previous version only listed top-level *.jsonl and missed ~270/290 files
      // on a typical session — sub-agent transcripts invisible → resume failed
      // silently because Claude couldn't find the referenced agent_id transcripts.
      const claudeDir = join(homedir(), '.claude', 'projects')
      const slugMap: Record<string, { files: Record<string, { mtime: number, size: number }> }> = {}

      const walkSlug = (slugDir: string): Record<string, { mtime: number, size: number }> => {
        const files: Record<string, { mtime: number, size: number }> = {}
        const walk = (dir: string, relPrefix: string): void => {
          let entries
          try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            if (e.name.startsWith('._') || e.name === '.DS_Store') continue
            const sub = join(dir, e.name)
            const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
            if (e.isDirectory()) {
              walk(sub, rel)
            } else if (e.isFile()) {
              try {
                const st = statSync(sub)
                files[rel] = { mtime: st.mtimeMs, size: st.size }
              } catch { /* skip unreadable */ }
            }
          }
        }
        walk(slugDir, '')
        return files
      }

      try {
        const slugs = readdirSync(claudeDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('._'))
          .map(d => d.name)

        for (const slug of slugs) {
          slugMap[slug] = { files: walkSlug(join(claudeDir, slug)) }
        }
      } catch {
        // projects dir doesn't exist yet — return empty
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ slugs: slugMap }))
      return
    }

    // POST /sessions/import — accept a gzipped tar and extract into ~/.claude/projects/
    if (req.method === 'POST' && url.pathname === '/sessions/import') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }
      const targetWorkDir = url.searchParams.get('targetWorkDir')

      const tmpDir = mkdtempSync(join(tmpdir(), 'osborn-import-'))
      const tarProc = spawn('tar', ['-xf', '-', '-C', tmpDir])

      // Stream-sniff the first chunk to detect gzip magic bytes (0x1f 0x8b).
      // Then route through createGunzip() if gzip, otherwise pipe raw to tar.
      // This avoids any reliance on Content-Type or Content-Encoding headers.
      const passthrough = new PassThrough()
      let sniffDone = false
      req.once('data', (firstChunk: Buffer) => {
        sniffDone = true
        const isGzip = firstChunk[0] === 0x1f && firstChunk[1] === 0x8b
        passthrough.write(firstChunk)
        req.pipe(passthrough)
        const source = isGzip ? passthrough.pipe(createGunzip()) : passthrough
        source.pipe(tarProc.stdin)
      })
      req.once('end', () => {
        if (!sniffDone) {
          // Empty body — just end tar stdin
          passthrough.end()
          tarProc.stdin.end()
        }
      })

      tarProc.stdin.on('error', (err: Error) => {
        console.error('[import] tar stdin error', err)
        tarProc.kill('SIGTERM')
        rmSync(tmpDir, { recursive: true, force: true })
        if (!res.headersSent) {
          res.writeHead(500)
          res.end(JSON.stringify({ error: 'upload error' }))
        }
      })

      req.on('aborted', () => {
        tarProc.kill('SIGTERM')
        rmSync(tmpDir, { recursive: true, force: true })
      })

      tarProc.stderr.on('data', (d: Buffer) => console.error('[import]', d.toString()))

      tarProc.on('close', async (code: number | null) => {
        try {
          if (code !== 0) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: 'tar extraction failed', code }))
            return
          }
          const { filesWritten, remapped } = await mergeExtractedIntoProjects(tmpDir, targetWorkDir ?? undefined)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, filesWritten, remapped }))
        } catch (err) {
          console.error('[import] merge error:', err)
          if (!res.headersSent) {
            res.writeHead(500)
            res.end(JSON.stringify({ error: 'Failed to merge sessions', detail: String(err) }))
          }
        } finally {
          rmSync(tmpDir, { recursive: true, force: true })
        }
      })
      return
    }

    // POST /sessions/import-chunk — accept a single chunk of a multi-part upload
    if (req.method === 'POST' && url.pathname === '/sessions/import-chunk') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }

      const uploadId = url.searchParams.get('uploadId')
      const chunkIndex = parseInt(url.searchParams.get('chunk') || '0')

      if (!uploadId) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'uploadId required' }))
        return
      }

      // Chunk storage dir: /tmp/osborn-upload-<uploadId>/
      const uploadDir = join(tmpdir(), `osborn-upload-${uploadId}`)
      mkdirSync(uploadDir, { recursive: true })

      // Write chunk to padded filename for correct sort order
      const chunkPath = join(uploadDir, `chunk-${String(chunkIndex).padStart(6, '0')}`)
      const writeStream = createWriteStream(chunkPath)
      req.pipe(writeStream)

      writeStream.on('finish', () => {
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, chunk: chunkIndex }))
      })

      writeStream.on('error', (err) => {
        console.error('[import-chunk] write error', err)
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'write failed' })) }
      })

      req.on('aborted', () => { writeStream.destroy() })
      return
    }

    // POST /sessions/import-finalize — reassemble chunks, extract, apply slug merge
    if (req.method === 'POST' && url.pathname === '/sessions/import-finalize') {
      if (syncToken) {
        const authHeader = req.headers['authorization'] ?? ''
        if (authHeader !== `Bearer ${syncToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
      }

      const uploadId = url.searchParams.get('uploadId')
      const total = parseInt(url.searchParams.get('total') || '0')
      const targetWorkDir = url.searchParams.get('targetWorkDir') ?? undefined

      if (!uploadId || total === 0) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'uploadId and total required' }))
        return
      }

      const uploadDir = join(tmpdir(), `osborn-upload-${uploadId}`)

      // Verify all chunks present
      const expectedChunks = Array.from({ length: total }, (_, i) => `chunk-${String(i).padStart(6, '0')}`)
      const presentChunks = existsSync(uploadDir) ? readdirSync(uploadDir).filter(f => f.startsWith('chunk-')).sort() : []

      const missing = expectedChunks.filter(c => !presentChunks.includes(c))
      if (missing.length > 0) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'missing chunks', missing }))
        return
      }

      const tmpExtractDir = mkdtempSync(join(tmpdir(), 'osborn-import-'))

      try {
        // Reassemble all chunks into a combined buffer, then sniff first 2 bytes
        // to detect gzip magic (0x1f 0x8b). Route through createGunzip() if gzip,
        // otherwise pass raw bytes — always using tar -xf (no -z flag).
        const chunkBuffers: Buffer[] = []
        for (const chunkFile of expectedChunks) {
          chunkBuffers.push(readFileSync(join(uploadDir, chunkFile)))
        }
        const combined = Buffer.concat(chunkBuffers)
        const isGzip = combined[0] === 0x1f && combined[1] === 0x8b

        const tarProc = spawn('tar', ['-xf', '-', '-C', tmpExtractDir])

        // Feed combined buffer through gunzip (if needed) then into tar stdin
        const feedStream = new PassThrough()
        const tarInput = isGzip ? feedStream.pipe(createGunzip()) : feedStream
        tarInput.pipe(tarProc.stdin)
        feedStream.end(combined)

        const streamChunks = async () => {
          // feeding is already initiated above; just return a resolved promise
          await Promise.resolve()
        }

        streamChunks().catch(err => {
          console.error('[import-finalize] chunk stream error', err)
          tarProc.kill('SIGTERM')
        })

        tarProc.stderr.on('data', (d: Buffer) => console.error('[import-finalize]', d.toString()))

        tarProc.on('close', async (code: number | null) => {
          try {
            if (code !== 0) {
              res.writeHead(500); res.end(JSON.stringify({ error: 'tar extraction failed', code })); return
            }
            const { filesWritten, remapped } = await mergeExtractedIntoProjects(tmpExtractDir, targetWorkDir)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, filesWritten, remapped }))
          } catch (err) {
            console.error('[import-finalize] merge error:', err)
            if (!res.headersSent) {
              res.writeHead(500)
              res.end(JSON.stringify({ error: 'Failed to merge sessions', detail: String(err) }))
            }
          } finally {
            rmSync(uploadDir, { recursive: true, force: true })
            rmSync(tmpExtractDir, { recursive: true, force: true })
          }
        })
      } catch (err) {
        rmSync(uploadDir, { recursive: true, force: true })
        rmSync(tmpExtractDir, { recursive: true, force: true })
        throw err
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  const host = process.env.HOST || '0.0.0.0'
  server.requestTimeout = 0  // no timeout — large uploads can take minutes
  server.listen(port, host, () => {
    console.log(`🌐 API server listening on http://${host}:${port}`)
    console.log(`   Sessions: http://${host}:${port}/sessions`)
  })

  // Stale upload-chunk cleanup: remove osborn-upload-* dirs older than 30 minutes
  const cleanStaleUploadDirs = () => {
    const tmp = tmpdir()
    const cutoff = Date.now() - 30 * 60 * 1000
    try {
      const entries = readdirSync(tmp)
      for (const entry of entries) {
        if (!entry.startsWith('osborn-upload-')) continue
        const full = `${tmp}/${entry}`
        try {
          const st = statSync(full)
          if (st.isDirectory() && st.mtimeMs < cutoff) {
            rmSync(full, { recursive: true, force: true })
            console.log(`🧹 Removed stale upload dir: ${full}`)
          }
        } catch {
          // ignore per-entry errors
        }
      }
    } catch {
      // ignore if /tmp is unreadable
    }
  }
  cleanStaleUploadDirs()
  setInterval(cleanStaleUploadDirs, 10 * 60 * 1000)

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ API port ${port} in use, trying ${port + 1}...`)
      startApiServer(workingDir, port + 1)
    } else {
      console.error('❌ API server error:', err)
    }
  })
}

// ============================================================
// SESSION CONTEXT HELPERS
// ============================================================

/**
 * Build a context briefing string for the realtime agent
 * Loads session conversation history so the model has deep context.
 * Gemini has smaller context limits — cap at 10 exchanges with 500 char content.
 * OpenAI handles full history (30 exchanges, 2000 char content).
 */

/**
 * Load full session conversation history into the realtime model's ChatContext.
 * This gives the model persistent memory of what was discussed/researched,
 * enabling deeper follow-up conversations without re-delegating to ask_agent.
 *
 * NOTE: Gemini's Live API doesn't support updateChatCtx (crashes with code 1008).
 * For Gemini, the session resume context is already injected via generateReply({ userInput })
 * which becomes part of the conversation history as model turns.
 */
function loadSessionHistoryIntoChatCtx(
  agent: voice.Agent | null,
  history: ConversationExchange[],
  provider?: string
) {
  if (!agent || history.length === 0) return
  // Skip for Gemini — updateChatCtx triggers unsupported operations on Gemini Live API
  if (provider === 'gemini') {
    console.log(`🧠 Skipping ChatCtx load for Gemini (${history.length} exchanges) — context injected via generateReply`)
    return
  }

  try {
    const chatCtx = agent.chatCtx.copy()

    // Inject each conversation exchange as a proper chat message
    for (const exchange of history) {
      chatCtx.addMessage({
        role: exchange.role === 'user' ? 'user' : 'assistant',
        content: exchange.content,
      })
    }

    agent.updateChatCtx(chatCtx)
    console.log(`🧠 Loaded ${history.length} conversation exchanges into ChatCtx (${history.reduce((sum, e) => sum + e.content.length, 0)} chars)`)
  } catch (err) {
    console.log('⚠️ Failed to load session history into ChatCtx:', err)
  }
}


// Main function
async function main() {
  console.log('\n🤖 Osborn Voice AI Coding Assistant\n')

  // Validate environment
  const livekitUrl = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET

  if (!livekitUrl || !apiKey || !apiSecret) {
    console.error('❌ Missing required environment variables:')
    if (!livekitUrl) console.error('   - LIVEKIT_URL')
    if (!apiKey) console.error('   - LIVEKIT_API_KEY')
    if (!apiSecret) console.error('   - LIVEKIT_API_SECRET')
    console.error('\nSet these in your .env file or environment.')
    process.exit(1)
  }

  // Parse CLI args
  const cliArgs = parseArgs()

  // Load configuration
  console.log('📁 Loading configuration...')
  const config = loadConfig()
  const mcpServers = getMcpServers(config)
  const enabledMcpNames = getEnabledMcpServerNames(config)

  if (enabledMcpNames.length > 0) {
    console.log(`🔌 Enabled MCP servers: ${enabledMcpNames.join(', ')}`)
  }

  // Two directory concepts:
  // 1. workingDir (cwd) — where Claude Code operates. Configurable per-session.
  //    Priority: OSBORN_CWD env > config.workingDirectory > process.cwd()
  // 2. sessionBaseDir — where session artifacts live (spec.md, library/).
  //    Always the Osborn agent install directory (where this process started).
  //    This ensures .osborn/sessions/ doesn't scatter across random directories.
  const sessionBaseDir = process.cwd() // Always the Osborn install dir
  // Self-healing fallback: blindly trusting OSBORN_CWD without checking that the directory
  // exists has bitten us in cloud sandboxes where the env var was set to a path that didn't
  // exist (e.g. `/root/workspace` on a daytona/* user). The Claude SDK then fails its spawn
  // call with ENOENT and reports the misleading "Claude Code executable not found" error.
  // Walk the candidate list in priority order and pick the first one that ACTUALLY exists.
  // process.cwd() is the ultimate safety net — it always exists by definition.
  const cwdCandidates: Array<{ source: string; value: string | undefined }> = [
    { source: 'OSBORN_CWD env var', value: process.env.OSBORN_CWD },
    { source: 'config.workingDirectory', value: config.workingDirectory },
    { source: 'process.cwd()', value: process.cwd() },
  ]
  let defaultWorkingDir = process.cwd()
  let cwdSource = 'process.cwd() (last-resort fallback)'
  for (const c of cwdCandidates) {
    if (c.value && existsSync(c.value)) {
      defaultWorkingDir = c.value
      cwdSource = c.source
      break
    }
    if (c.value) {
      console.log(`   ⚠️ ${c.source} = ${c.value} (does not exist, skipping)`)
    }
  }
  let workingDir = defaultWorkingDir
  console.log(`📂 Working directory (cwd): ${workingDir}`)
  console.log(`📂 Session base directory: ${sessionBaseDir}`)
  console.log(`   (cwd from ${cwdSource})`)
  console.log(`🔬 Mode: RESEARCH`)

  // Determine voice mode
  const voiceMode = getVoiceMode(config)
  const realtimeConfig = getRealtimeConfig(config)
  const directConfig = getDirectConfig(config)

  if (voiceMode === 'realtime') {
    console.log(`🎙️ REALTIME MODE: ${realtimeConfig.provider} native speech-to-speech`)
    console.log(`   Voice: ${realtimeConfig.provider === 'openai' ? realtimeConfig.openaiVoice : realtimeConfig.geminiVoice}`)
  } else {
    console.log(`🎯 DIRECT MODE: ${directConfig.stt.provider} STT → Claude Agent SDK → ${directConfig.tts.provider} TTS`)
    console.log('   🔥 Full coding capabilities!')
  }

  // Determine room code
  const roomCode = cliArgs.roomCode || generateRoomCode()
  currentRoomCode = roomCode
  const roomName = `osborn-${roomCode}`

  if (cliArgs.roomCode) {
    console.log(`🔗 Joining room: ${roomCode}`)
  } else {
    console.log(`\n✨ Created new room: ${roomCode}`)
    console.log(`\n📋 Share this with the frontend or run:`)
    console.log(`   Open: https://osborn.app?room=${roomCode}`)
    console.log(`   Or enter code "${roomCode}" in the frontend\n`)
  }

  // Start HTTP API server for frontend session browsing
  const apiPort = parseInt(process.env.OSBORN_API_PORT || '8741', 10)
  startApiServer(workingDir, apiPort)

  // ============================================================
  // Create Access Token for Agent
  // ============================================================
  console.log('🔑 Creating access token...')

  const token = new AccessToken(apiKey, apiSecret, {
    identity: 'osborn-agent',
    name: 'Osborn AI',
    metadata: JSON.stringify({ type: 'agent', version: '0.3.0' }),
  })

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })

  const jwt = await token.toJwt()

  // ============================================================
  // Connect to Room
  // ============================================================
  console.log('📡 Connecting to LiveKit...')

  const room = new Room()
  room.setMaxListeners(50)  // Prevent MaxListenersExceeded warnings on reconnect

  // Track state
  let pendingSessionClose: Promise<void> | null = null  // Tracks async session close for reconnect safety
  let currentSession: voice.AgentSession | null = null
  let currentAgent: voice.Agent | null = null  // For updateChatCtx() context injection
  let currentLLM: ReturnType<typeof createClaudeLLM> | null = null

  /**
   * Hard-kill the in-flight Claude SDK query AND the persistent subprocess.
   *
   * Why this exists: the persistent ClaudeLLM session is deliberately kept alive
   * across user messages to avoid JSONL replay (see CLAUDE.md "Persistent Session
   * Architecture"). When the participant disconnects, simply nulling `currentLLM`
   * drops the JS reference but does NOT kill the underlying Claude Code subprocess
   * — the SDK keeps draining the MessageChannel, running tools, and pushing TTS
   * calls into a now-null voice session. Visible in logs as repeated:
   *   "⚠️ tts_say fired but currentSession is null — text dropped"
   * followed by orphaned `🔧 Claude: Bash` calls and `📍 Checkpoint captured` lines
   * that nobody is listening to. Wasted compute, wasted tokens, possible side effects.
   *
   * The right cleanup is `abortQuery()` (on ClaudeLLM directly) or `abortAgent()`
   * (on PipelineDirectLLM, which wraps ClaudeLLM). They both call into
   * `closeSession()` → kills the subprocess. We duck-type to handle both class
   * shapes since `currentLLM` can hold either, depending on voice mode.
   */
  function killCurrentLLM(reason: string): void {
    if (!currentLLM) return
    try {
      const llm = currentLLM as any
      if (typeof llm.abortQuery === 'function') {
        llm.abortQuery()
      } else if (typeof llm.abortAgent === 'function') {
        llm.abortAgent()
      } else {
        console.warn(`⚠️ killCurrentLLM(${reason}): no abort method on currentLLM`)
      }
    } catch (err) {
      console.error(`❌ killCurrentLLM(${reason}) failed:`, err instanceof Error ? err.message : err)
    }
  }

  let localParticipant: LocalParticipant | null = null
  let agentState = 'initializing'
  // Session-level always-allow list: paths the user has approved for this session without prompting
  let sessionAlwaysAllowPaths = new Set<string>()
  let userState = 'listening'  // Track user speech state for queue safety
  let currentVoiceMode: VoiceMode = voiceMode  // Track active voice mode for data handlers
  let currentProvider: string = realtimeConfig.provider  // Track active realtime provider
  // Authenticated Supabase userId from participant metadata. Used to scope
  // workspace artifact uploads to the owner's prefix in Supabase Storage.
  // Empty string = anonymous / unauthenticated; uploads fall back to a
  // session-only path (no user prefix).
  let currentUserId: string = ''

  // Track the active resume session ID across scopes (ParticipantConnected + DataReceived)
  // Updated by resume_session, session_selected, continue_session, switch_session handlers
  let currentResumeSessionId: string | undefined

  // Claude auth code submission handler (set during OAuth flow, cleared after)
  let pendingAuthSubmitCode: ((code: string) => void) | null = null

  // Task deduplication guard - prevents Gemini re-execution loops
  let lastTaskRequest = ''
  let lastTaskTime = 0

  // Fast brain (ask_haiku) in-flight tracking — prevents ask_agent double-calling
  let haikuInFlight: { question: string, time: number } | null = null

  // Background research state - tracks async ask_agent execution
  let activeResearch: {
    researchLog: string[]
    pendingUpdates: string[] // Queue of updates waiting to be injected
    cleanup: () => void
    voiceUpdateCount: number // Track voice injection count (no cap — 8s debounce prevents flooding)
    abortController: AbortController // Abort SDK query on disconnect
  } | null = null

  // Persist last completed research context so follow-up questions can reference it
  // (activeResearch is set to null on completion — this preserves the context)
  let lastCompletedResearch: {
    task: string
    researchLog: string[]
    completedAt: number
  } | null = null

  // No manual queuing — the Claude SDK handles sequential queries internally

  // ============================================================
  // Recall.ai — Meeting Transcript Routing
  // ============================================================
  const recall = getRecallClient()
  if (recall) {
    console.log('🎥 Recall.ai client initialized (RECALL_API_KEY present)')
    recall.on('transcript', ({ botId, speaker, text }: { botId: string, speaker: string, text: string }) => {
      console.log(`📝 Meeting transcript [${speaker}]: ${text}`)
      // Route meeting transcripts to Claude as user text with speaker attribution
      if (currentLLM && currentSession) {
        const meetingText = `[Meeting — ${speaker}]: ${text}`
        // Use the same pipeline as user_text data channel messages
        try {
          if (currentVoiceMode === 'pipeline' || currentVoiceMode === 'direct') {
            const chatCtx = new llm.ChatContext()
            chatCtx.addMessage({ role: 'user', content: meetingText })
            ;(currentLLM as any).chat({ chatCtx })
          }
        } catch (err) {
          console.error('❌ Failed to route meeting transcript:', err)
        }
      }
    })
  }

  // ============================================================
  // Interruption Tracking (Content Ledger)
  // ============================================================
  // When user interrupts TTS, LiveKit truncates chatCtx to what was spoken.
  // We capture the spoken text (synchronizedTranscript) and on the next user
  // message, read Claude's full output from JSONL + inject context so Claude
  // knows what was heard vs lost. Claude decides: side question → answer +
  // continue, or redirect → follow new direction.

  // Current SpeechHandle from session.say() — only the latest one matters
  let currentSpeechHandle: any = null

  // Last interruption context — gathered at interrupt time, consumed when user's message arrives
  let lastInterruption: {
    spokenText: string       // synchronizedTranscript — what user heard (word-accurate)
    recentMessages: string   // last 10 assistant messages from JSONL (full untruncated)
    timestamp: number
  } | null = null

  /**
   * Called when a SpeechHandle finishes (interrupted or not).
   * If interrupted: gather spoken text + JSONL context. Does NOT send to Claude yet —
   * that happens when the user's transcribed message arrives via chat().
   */
  async function handleSpeechDone(handle: any, fullText: string, fullBlockText?: string) {
    if (!handle.interrupted) {
      lastInterruption = null
      return
    }

    // fullText is the synchronized (word-accurate) transcript of what was actually spoken
    // before the interruption. fullBlockText is the original full TTS segment text.
    const fullBlockLen = fullBlockText?.length ?? fullText.length
    console.log(`🔇 Speech interrupted. Heard (${fullText.length} chars): "${fullText}" [full block was ${fullBlockLen} chars]`)

    // Read last 10 assistant messages from JSONL (Claude's full untruncated output).
    // SessionMessage.text is pre-joined from all text content blocks.
    let recentMessages = ''
    const sessionId = currentLLM?.sessionId
    if (sessionId) {
      try {
        const { readSessionHistory } = await import('./session-access.js')
        const history = readSessionHistory(sessionId, workingDir, {
          lastN: 10,
          types: ['assistant'],
        })
        recentMessages = history
          .filter((m: any) => m.text)
          .map((m: any) => m.text)
          .join('\n---\n')
      } catch (err) {
        console.warn('⚠️ Failed to read JSONL for interruption context:', err)
      }
    }

    // Store — consumed when user's next message arrives via chat()
    lastInterruption = { spokenText: fullText, recentMessages, timestamp: Date.now() }
    console.log(`📋 Interruption context stored (text: ${fullText.length} chars, JSONL: ${recentMessages.length} chars)`)
  }

  /**
   * Callback for PipelineDirectLLM — returns pending interruption context and clears it.
   * Called in chat() when user's transcribed message arrives.
   * PipelineDirectLLM enriches the user message with this context before sending to Claude.
   */
  function getAndConsumeInterruptionContext() {
    if (!lastInterruption) return null
    // Expire after 60s — user may have waited too long
    if (Date.now() - lastInterruption.timestamp > 60_000) {
      lastInterruption = null
      return null
    }
    const ctx = { spokenText: lastInterruption.spokenText, recentMessages: lastInterruption.recentMessages }
    lastInterruption = null
    return ctx
  }

  // ============================================================
  // Unified Voice Injection Queue
  // ============================================================
  // ALL system injections (research updates, completions, notifications, errors)
  // go through this queue. Never call generateReply directly for injections.
  // The queue only drains when the voice model is confirmed 'listening'.
  // After draining, the model transitions to thinking/speaking, and the queue
  // naturally pauses until the next 'listening' state.

  const voiceQueue: string[] = []
  let isProcessingQueue = false

  function queueVoiceInjection(instructions: string) {
    voiceQueue.push(instructions)
    console.log(`📥 Voice queue: +1 (total: ${voiceQueue.length}): ${instructions.substring(0, 80)}...`)
    processVoiceQueue()
  }

  function processVoiceQueue() {
    if (voiceQueue.length === 0) return
    if (!currentSession) return
    if (isProcessingQueue) {
      console.log(`⏸️ Voice queue: already processing, ${voiceQueue.length} items waiting`)
      return
    }
    if (agentState !== 'listening') {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (model: ${agentState})`)
      return // Will be called again when agent_state_changed → 'listening'
    }
    // Don't inject while user is speaking — server-side VAD will auto-create a response
    if (userState === 'speaking') {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (user speaking)`)
      return
    }
    // Don't inject while fast brain tool call is in flight — the tool response will
    // race with our generateReply, causing Gemini to drop our content and only speak
    // the tool response. Wait for the tool call to complete first.
    if (haikuInFlight) {
      console.log(`⏸️ Voice queue: ${voiceQueue.length} items waiting (fast brain in flight: "${haikuInFlight.question.substring(0, 40)}...")`)
      return // Will be retried when haikuInFlight clears (see tool execute handler)
    }

    isProcessingQueue = true

    // Batch ALL queued items into one generateReply call
    const items = voiceQueue.splice(0)
    const batchedInstruction = items.length === 1
      ? items[0]
      : items.join('\n\n---\n\n')

    console.log(`📡 Voice queue: processing ${items.length} batched items (${batchedInstruction.length} chars)`)

    // Safety timeout: if agent_state_changed never fires (edge case — e.g. Gemini
    // WebSocket drops, or state machine hangs). 15s gives the model time to process.
    setTimeout(() => {
      if (isProcessingQueue) {
        console.log('⚠️ Voice queue: safety timeout — clearing guard')
        isProcessingQueue = false
        if (voiceQueue.length > 0 && agentState === 'listening') {
          processVoiceQueue()
        }
      }
    }, 15000)

    try {
      // Skip interrupt for Gemini — disrupts Gemini's state machine, causing it to
      // never transition back to 'listening' (hangs in speaking state indefinitely)
      if (currentProvider !== 'gemini') {
        currentSession.interrupt()
      }

      if (currentProvider === 'gemini') {
        // LiveKit SDK v1.0.51: generateReply({ instructions }) sends a system turn +
        // synthetic "." user turn. After Gemini processes a tool call in this flow,
        // autoToolReplyGeneration does NOT trigger continuation (system-only limitation).
        // Using userInput instead makes it a "user-initiated" request where auto-continuation
        // works. The ask_fast_brain injection bypass handles [SCRIPT]/[PROACTIVE]/[NOTIFICATION]
        // prefixes and returns the content directly as a tool response.
        currentSession.generateReply({
          userInput: batchedInstruction,
        })
      } else {
        // OpenAI respects toolChoice:'none' — speaks instructions directly
        currentSession.generateReply({
          instructions: batchedInstruction,
          toolChoice: 'none' as any,
        })
      }
      // Model transitions to thinking/speaking after this call.
      // When it returns to 'listening', agent_state_changed triggers processVoiceQueue() again.

      // Also inject into chatCtx as persistent context so the model remembers across turns
      injectIntoChatCtx(batchedInstruction)
    } catch (err) {
      console.log('⚠️ Voice queue generateReply failed:', err)
      isProcessingQueue = false
    }
    // isProcessingQueue is cleared when agent_state_changed fires
  }

  // Inject content into the agent's ChatContext as persistent memory
  // This ensures the realtime model can reference prior research in follow-up questions
  // NOTE: Gemini doesn't support updateChatCtx (crashes with "Operation not implemented" code 1008).
  // For Gemini, generateReply({ instructions }) already injects as model turns, so context persists naturally.
  function injectIntoChatCtx(content: string) {
    if (!currentAgent) return
    // Skip for Gemini — updateChatCtx triggers unsupported operations on Gemini Live API
    if (currentVoiceMode === 'realtime' && currentProvider === 'gemini') return
    try {
      const chatCtx = currentAgent.chatCtx.copy()
      chatCtx.addMessage({
        role: 'assistant',
        content: content,
      })
      currentAgent.updateChatCtx(chatCtx)
      console.log(`🧠 ChatCtx updated (+${content.length} chars persistent context)`)
    } catch (err) {
      console.log('⚠️ ChatCtx injection failed:', err)
    }
  }

  // Extract recent voice conversation turns from the realtime LLM's in-memory ChatContext.
  // Replaces the internal conversationHistory array in fast-brain.ts.
  function getChatHistory(maxTurns: number = 20): ConversationTurn[] {
    if (!currentAgent) return []
    try {
      const items = currentAgent.chatCtx.items
      const turns: ConversationTurn[] = []
      for (const item of items) {
        if ((item as any).type !== 'message') continue
        const msg = item as any
        if (msg.role !== 'user' && msg.role !== 'assistant') continue
        const text = msg.textContent ?? ''
        if (!text.trim()) continue
        turns.push({ role: msg.role, text: text.trim() })
      }
      return turns.slice(-maxTurns)
    } catch (err) {
      console.log('⚠️ getChatHistory: failed to read chatCtx:', err)
      return []
    }
  }

  // Research event batching — debounce rapid-fire tool events into a single voice queue entry
  let researchBatchTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleResearchBatch() {
    if (researchBatchTimer) return // Already scheduled
    researchBatchTimer = setTimeout(() => {
      researchBatchTimer = null
      if (!activeResearch || activeResearch.pendingUpdates.length === 0) return

      const updates = activeResearch.pendingUpdates.splice(0)
      const batchText = updates.slice(-10).join('. ')
      console.log(`📡 [research] Batching ${updates.length} events: ${batchText.substring(0, 80)}...`)

      // Send to frontend for visibility
      sendToFrontend({
        type: 'claude_output',
        text: `[Research Progress] ${batchText}`,
        isStreaming: true,
        agentRole: 'research-progress',
      })

      // Route through fast brain — it decides whether to speak (usually silent)
      if (activeResearch.voiceUpdateCount < 2) {
        const voiceSid = currentLLM?.sessionId
        if (voiceSid) {
          const chatHistory = getChatHistory(10)
          handleResearchBatch(workingDir, voiceSid, lastTaskRequest || '', updates, activeResearch.researchLog, chatHistory, workingDir)
            .then(script => {
              if (script && activeResearch) {
                activeResearch.voiceUpdateCount++
                queueVoiceInjection(getScriptInjection(script))
              }
            })
            .catch(() => {}) // Silent fail — updates are optional
        }
      }
    }, 8000) // 8s debounce: reduces voice queue flooding during research
  }

  // Proactive conversational loop — keeps conversation alive during research
  let proactiveTimer: ReturnType<typeof setInterval> | null = null
  let proactivePromptHistory: string[] = []
  const PROACTIVE_INTERVAL = 15000  // 15 seconds (offset from 8s batch timer)
  const MAX_PROACTIVE_PROMPTS = 2   // Cap per research task (reduced from 4 to minimize realtime LLM tokens)

  function startProactiveLoop(task: string, sessionId: string) {
    stopProactiveLoop()
    proactivePromptHistory = []
    let proactiveCount = 0

    proactiveTimer = setInterval(async () => {
      if (!activeResearch) { stopProactiveLoop(); return }
      if (proactiveCount >= MAX_PROACTIVE_PROMPTS) return
      if (agentState !== 'listening' || userState === 'speaking') return
      if (researchBatchTimer) return  // Don't collide with batch updates
      if (isProcessingQueue) return   // Don't collide with voice queue

      try {
        const prompt = await generateProactivePrompt(
          workingDir, sessionId, task,
          activeResearch.researchLog,
          proactivePromptHistory,
          sessionBaseDir,
        )
        if (prompt && prompt !== 'NOTHING') {
          proactivePromptHistory.push(prompt)
          proactiveCount++
          queueVoiceInjection(getProactiveInjection(prompt))
        }
      } catch {} // Silent fail — proactive prompts are optional
    }, PROACTIVE_INTERVAL)
  }

  function stopProactiveLoop() {
    if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null }
    proactivePromptHistory = []
  }

  // Helper to send data to frontend (with size limit handling)
  //
  // WebRTC SCTP data channel max message size is ~256KB. Sending larger
  // payloads corrupts the publisher transport, killing ALL subsequent sends.
  // We enforce a soft limit (truncate text/content fields) and a hard limit
  // (drop the message entirely with a warning) to prevent this.
  // ⚠️ These limits protect the LiveKit SCTP publisher peer connection.
  // During session resume, 12 artifact requests arrive simultaneously and the agent
  // sends responses back-to-back. If the cumulative payload exceeds the SCTP buffer
  // (~50-100 KB in rapid fire), the publisher PC enters a zombie state and NEVER
  // recovers — the user hears nothing for the rest of the connection. Keep these low.
  const MAX_MESSAGE_SIZE = 30000       // 30KB soft limit — truncate text/content fields
  const HARD_MAX_MESSAGE_SIZE = 50000  // 50KB hard limit — drop if still too large after truncation

  async function sendToFrontend(data: object) {
    if (!localParticipant) {
      console.log('⚠️ sendToFrontend: no localParticipant!')
      return
    }
    try {
      const encoder = new TextEncoder()
      let jsonData = JSON.stringify(data)

      // If message is too large, truncate the text or content field
      if (jsonData.length > MAX_MESSAGE_SIZE) {
        const truncatedData = { ...data } as any
        // Try truncating .text first (assistant_response, claude_output, etc.)
        if (truncatedData.text && typeof truncatedData.text === 'string') {
          const overhead = JSON.stringify({ ...truncatedData, text: '' }).length
          const maxTextLength = MAX_MESSAGE_SIZE - overhead - 100
          truncatedData.text = truncatedData.text.substring(0, maxTextLength) + '\n\n[Message truncated due to size limit]'
          jsonData = JSON.stringify(truncatedData)
          console.log(`⚠️ Message truncated .text from ${(data as any).text?.length} to ${truncatedData.text.length} chars`)
        }
        // Also try truncating .content (research_artifact_content, plan_file_content)
        if (jsonData.length > MAX_MESSAGE_SIZE && truncatedData.content && typeof truncatedData.content === 'string') {
          const overhead = JSON.stringify({ ...truncatedData, content: '' }).length
          const maxContentLength = MAX_MESSAGE_SIZE - overhead - 100
          truncatedData.content = truncatedData.content.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]'
          truncatedData.truncated = true
          truncatedData.originalSize = Buffer.byteLength((data as any).content, 'utf-8')
          jsonData = JSON.stringify(truncatedData)
          console.log(`⚠️ Message truncated .content from ${(data as any).content?.length} to ${truncatedData.content.length} chars`)
        }
      }

      // Hard cap — if still too large after truncation, drop entirely.
      // This prevents a 480KB base64 image or similar from killing the
      // WebRTC publisher transport (which is unrecoverable without reconnect).
      const payload = encoder.encode(jsonData)
      if (payload.length > HARD_MAX_MESSAGE_SIZE) {
        console.error(`❌ sendToFrontend: dropping message (${(payload.length / 1024).toFixed(0)}KB > ${(HARD_MAX_MESSAGE_SIZE / 1024).toFixed(0)}KB hard limit) — type: ${(data as any).type}`)
        return
      }

      await localParticipant.publishData(payload, {
        reliable: true,
        topic: 'osborn-updates',
      })
      console.log(`📤 Sent to frontend: ${(data as any).type} (${payload.length} bytes)`)
    } catch (err) {
      console.error('❌ sendToFrontend error:', err)
    }
  }

  // Helper: announce via voice - uses voice queue for realtime, say() for direct
  async function announceViaVoice(text: string) {
    if (!currentSession) return
    if (currentVoiceMode === 'realtime') {
      queueVoiceInjection(getNotificationInjection(text))
    } else {
      try {
        await (currentSession as any).say(text)
      } catch (err) {
        console.log('⚠️ Voice announcement failed:', err)
      }
    }
  }

  // Create DIRECT session (STT + Claude Agent SDK + TTS)
  async function createDirectSession(resumeSessionId?: string, llmOverride?: any): Promise<{ session: voice.AgentSession; agent: voice.Agent }> {
    console.log('🎯 Creating direct session...')

    const stt = createSTT(DIRECT_MODE_STT)
    const tts = createTTS(DIRECT_MODE_TTS)

    // Create Claude LLM wrapper — direct mode uses speech-optimized system prompt
    // skipTTSQueue: bypass LiveKit's BufferedTokenStream, use session.say() instead
    // llmOverride: pipeline mode passes PipelineDirectLLM which wraps its own ClaudeLLM
    const directLLM = llmOverride || createClaudeLLM({
      workingDirectory: workingDir,
      sessionBaseDir,
      mcpServers,
      resumeSessionId,
      voiceMode: 'direct',
      skipTTSQueue: true,
      onCompactionEvent: (event) => {
        try {
          // Forward every field — frontend renders stage + detail + skill list during compaction.
          // Spread covers compaction_started/progress/complete (different fields per type).
          sendToFrontend({ ...event } as any)
        } catch { /* non-fatal */ }
      },
    })
    currentLLM = directLLM

    // Reset the session always-allow list for each new direct session
    sessionAlwaysAllowPaths = new Set<string>()

    // For resumed sessions, eagerly create workspace (we know the real ID)
    if (resumeSessionId) {
      const workspace = ensureSessionWorkspace(workingDir, resumeSessionId)
      console.log(`📁 Session workspace (resumed): ${workspace}`)
    }

    // For new sessions, create workspace when SDK assigns real session ID
    directLLM.events.once('session_id', ({ sessionId }: { sessionId: string }) => {
      const workspace = ensureSessionWorkspace(workingDir, sessionId)
      console.log(`📁 Session workspace created: ${workspace}`)
      // Pipeline mode: pre-warm BM25 index so first fast brain query is fast
      if (currentVoiceMode === 'pipeline') {
        prewarmBM25Index(sessionId, workingDir).catch(() => {})
      }
    })

    // Also pre-warm for resumed sessions (sessionId already known)
    if (resumeSessionId && currentVoiceMode === 'pipeline') {
      prewarmBM25Index(resumeSessionId, workingDir).catch(() => {})
    }

    // Wire up MCP server changes to frontend
    directLLM.events.on('mcp_servers_changed', (data) => {
      console.log(`🔌 MCP servers changed: ${data.enabledKeys.join(', ') || 'none'}`)
      sendToFrontend({
        type: 'mcp_servers_changed',
        enabledKeys: data.enabledKeys,
        mcpServers: getMcpServerStatusList(config),
      })
    })

    // Wire up events from the Claude SDK wrapper to frontend
    directLLM.events.on('tool_use', (data) => {
      console.log(`🔧 Claude: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, agentRole: 'direct' })
    })

    directLLM.events.on('tool_result', (data) => {
      console.log(`✅ Done: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, status: 'completed', agentRole: 'direct' })

      // Detect research artifact writes (session workspace or legacy research dir)
      if ((data.name === 'Write' || data.name === 'Edit') && data.input?.file_path) {
        const fp = data.input.file_path
        if (fp.includes('/osb/') || fp.includes('.osborn/sessions/') || fp.includes('.osborn/research/')) {
          sendToFrontend({
            type: 'research_artifact_updated',
            filePath: fp,
            fileName: fp.split('/').pop(),
          })
        }
      }
    })

    // Wire up Claude text output - RAW text goes to frontend for chat bubbles
    directLLM.events.on('assistant_text', (data) => {
      console.log(`💬 Claude text (${data.text?.length || 0} chars): ${data.text || ''}`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: true,
        agentRole: 'direct',
      })
    })

    // Wire up Claude final result - RAW result goes to frontend
    directLLM.events.on('assistant_result', (data) => {
      console.log(`📋 Claude result (${data.text?.length || 0} chars): ${data.text || ''}`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: false,
        isFinal: true,
        agentRole: 'direct',
      })
    })

    // Wire up permission requests - sends to frontend for user approval
    directLLM.events.on('permission_request', (data) => {
      console.log(`⚠️ Permission needed: ${data.toolName}`)
      const toolName = data.toolName
      const input = data.input || {}

      // Check session always-allow list before showing dialog
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
        const filePath = String(input?.file_path || '')
        if (filePath && sessionAlwaysAllowPaths.has(filePath)) {
          console.log(`✅ Session always-allow: ${filePath}`)
          directLLM.respondToPermission(true)
          return
        }
      }

      // Build descriptive message based on tool type
      let description = `I need permission to use ${toolName}.`
      if (toolName === 'Bash' && input.command) {
        const cmd = String(input.command).substring(0, 60)
        description = `I want to run the command: ${cmd}${String(input.command).length > 60 ? '...' : ''}`
      } else if (toolName === 'Write' && input.file_path) {
        description = `I want to create or overwrite the file: ${input.file_path}`
      } else if (toolName === 'Edit' && input.file_path) {
        description = `I want to edit the file: ${input.file_path}`
      } else if (toolName === 'WebFetch' && input.url) {
        description = `I want to fetch content from: ${input.url}`
      }

      // Generate diff for Write/Edit/MultiEdit tools
      let diffString: string | undefined
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
        const diffStart = performance.now()
        try {
          const filePath = String(input?.file_path || '')
          let beforeContent = ''

          const readStart = performance.now()
          try {
            beforeContent = readFileSync(filePath, 'utf-8')
          } catch {
            beforeContent = '' // new file
          }
          const readMs = (performance.now() - readStart).toFixed(2)
          console.log(`⏱️ diff read: ${readMs}ms (${beforeContent.length} chars, ${filePath.split('/').pop()})`)

          let afterContent = beforeContent
          if (toolName === 'Write') {
            afterContent = String(input?.content || '')
          } else if (toolName === 'Edit') {
            const oldStr = String(input?.old_string || '')
            const newStr = String(input?.new_string || '')
            const replaceAll = Boolean(input?.replace_all)
            if (replaceAll) {
              afterContent = beforeContent.split(oldStr).join(newStr)
            } else {
              afterContent = beforeContent.replace(oldStr, newStr)
            }
          } else if (toolName === 'MultiEdit') {
            afterContent = beforeContent
            const edits = Array.isArray(input?.edits) ? input.edits as Array<{old_string: string, new_string: string, replace_all?: boolean}> : []
            for (const edit of edits) {
              if (edit.replace_all) {
                afterContent = afterContent.split(edit.old_string).join(edit.new_string)
              } else {
                afterContent = afterContent.replace(edit.old_string, edit.new_string)
              }
            }
          }

          const patchStart = performance.now()
          const fileName = filePath.split('/').pop() || filePath
          diffString = createPatch(fileName, beforeContent, afterContent, '', '', { context: 4 })
          const patchMs = (performance.now() - patchStart).toFixed(2)
          const totalMs = (performance.now() - diffStart).toFixed(2)
          console.log(`⏱️ diff patch: ${patchMs}ms | total: ${totalMs}ms (before: ${beforeContent.length} chars, after: ${afterContent.length} chars, diff: ${diffString.length} chars)`)
        } catch (e) {
          const totalMs = (performance.now() - diffStart).toFixed(2)
          console.log(`⏱️ diff failed after ${totalMs}ms:`, e)
          // diff generation failed — proceed without diff
          diffString = undefined
        }
      }

      console.log(`🔍 perm payload: diff=${diffString ? `✅ ${diffString.length} chars` : '❌ NONE'} toolName=${toolName}`)
      sendToFrontend({
        type: 'permission_request',
        toolName: data.toolName,
        input: data.input,
        description,
        agentRole: 'direct',
        diff: diffString,
      })
      // Speak the descriptive request so user knows to respond
      //do not delete!! Leave this section commented out
      // say permission, request permission, ask for permission with session.say
      // if (currentSession) {
      //   const ttsMessage = `${description} Say yes, no, or always.`
      //   // ;(currentSession as any).say?.(ttsMessage).catch(() => {})
      //   ;(currentSession as any).say?.(ttsMessage)
      // }
    })

    // Wire up TTS say — bypass LiveKit's BufferedTokenStream, speak directly via session.say()
    // Each text block from Claude gets spoken immediately as it arrives, no internal buffering
    directLLM.events.on('tts_say', (data) => {
      // Guard: session must be alive — TTS errors can kill the session while background query runs
      if (!currentSession) {
        console.warn(`⚠️ tts_say fired but currentSession is null — text dropped (${data.text?.length || 0} chars): "${data.text || ''}"`)
        return
      }
      if (!data.text?.trim()) {
        console.log(`🔇 tts_say fired but text is empty — skipping`)
        return
      }

      const sayId = Date.now() // simple ID to correlate start/end logs
      console.log(`🗣️ [${sayId}] session.say START (${data.text.length} chars): "${data.text}"`)

      try {
        const handle = (currentSession as any).say(data.text)

        if (handle && typeof handle.addDoneCallback === 'function') {
          // SpeechHandle — track it and register interruption callback
          currentSpeechHandle = handle
          // Wall-clock timer: capture when audio actually starts playing (first frame)
          // Used as fallback if LiveKit's playbackPosition is 0 (race condition)
          let playbackStartedAt: number | null = null
          const audioOutputRef = (currentSession as any)?.output?.audio
          if (audioOutputRef && typeof audioOutputRef.on === 'function') {
            const onPlaybackStarted = () => {
              playbackStartedAt = Date.now()
              console.log(`🔊 [${sayId}] audio first frame out (playbackStarted)`)
              audioOutputRef.off('playbackStarted', onPlaybackStarted)
            }
            audioOutputRef.on('playbackStarted', onPlaybackStarted)
          }
          handle.addDoneCallback((sh: any) => {
            if (sh.interrupted) {
              console.log(`🔇 [${sayId}] session.say INTERRUPTED`)
              const audioOutput = (currentSession as any)?.output?.audio
              const sdkTranscript = audioOutput?.lastPlaybackEvent?.synchronizedTranscript
              const sdkPlaybackSec = audioOutput?.lastPlaybackEvent?.playbackPosition ?? 0

              let spokenText: string
              let method: string

              if (sdkTranscript) {
                // Best case: LiveKit gave us word-accurate transcript (requires alignedTranscript TTS)
                spokenText = sdkTranscript
                method = 'sdk-transcript'
              } else if (sdkPlaybackSec > 0) {
                // Second: LiveKit gave us playback duration — estimate chars from it
                const CHARS_PER_SEC = 14
                const charCount = Math.min(Math.round(sdkPlaybackSec * CHARS_PER_SEC), data.text.length)
                const slicePoint = data.text.lastIndexOf(' ', charCount) || charCount
                spokenText = slicePoint > 0 ? data.text.slice(0, slicePoint) : data.text
                method = 'sdk-position'
              } else if (playbackStartedAt !== null) {
                // Third: use our wall-clock timer from first audio frame
                const elapsedSec = (Date.now() - playbackStartedAt) / 1000
                const CHARS_PER_SEC = 14
                const charCount = Math.min(Math.round(elapsedSec * CHARS_PER_SEC), data.text.length)
                const slicePoint = data.text.lastIndexOf(' ', charCount) || charCount
                spokenText = slicePoint > 0 ? data.text.slice(0, slicePoint) : data.text
                method = 'wall-clock'
              } else {
                // Fallback: interrupt fired before first frame — pass full block
                spokenText = data.text
                method = 'full-block-fallback'
              }

              console.log('🔇 Interruption estimate:', JSON.stringify({
                method,
                sdkPlaybackSec,
                isSynced: !!sdkTranscript,
                spokenChars: spokenText.length,
                fullChars: data.text.length,
                heard: spokenText.slice(0, 80) + (spokenText.length > 80 ? '...' : '')
              }))
              handleSpeechDone(sh, spokenText, data.text)
            } else {
              console.log(`✅ [${sayId}] session.say DONE`)
              if (currentSpeechHandle === sh) lastInterruption = null
            }
          })
          console.log(`🗣️ [${sayId}] session.say queued (SpeechHandle tracked)`)
        } else if (handle && typeof handle.then === 'function') {
          // Promise-based fallback (older SDK path)
          handle
            .then(() => console.log(`✅ [${sayId}] session.say DONE`))
            .catch((err: any) => console.error(`❌ [${sayId}] session.say FAILED:`, err?.message || err))
        }
      } catch (err: any) {
        // Catch synchronous "AgentSession is not running" errors
        console.warn(`⚠️ [${sayId}] session.say threw — session likely dead: ${err?.message}`)
      }
    })

    // Wire up session resume failure - notify frontend when SDK creates new session instead
    directLLM.events.on('session_resume_failed', (data) => {
      console.error(`❌ Session resume failed: ${data.requestedSessionId} → ${data.actualSessionId}`)
      sendToFrontend({
        type: 'session_resume_failed',
        requestedSessionId: data.requestedSessionId,
        actualSessionId: data.actualSessionId,
      })
    })

    // Wire up file checkpoint capture - track restore points for file rewind
    directLLM.events.on('checkpoint_captured', (data) => {
      console.log(`📍 Checkpoint: ${data.checkpointId.substring(0, 8)}...`)
      sendToFrontend({
        type: 'checkpoint_captured',
        checkpointId: data.checkpointId,
      })
    })

    // Create the Agent with instructions, STT, LLM, TTS
    // VAD (Silero ONNX) removed — caused 2-5s inference lag on CPU, making interruption detection worse
    // Turn detection is server-side (Deepgram endpointing), interruptions handled by STT
    const agent = new voice.Agent({
      instructions: DIRECT_MODE_PROMPT,
      stt,
      llm: directLLM,
      tts,
      turnDetection: 'stt',
    })

    const session = new voice.AgentSession({
      turnDetection: 'stt',
      preemptiveGeneration: false,  // Only fire LLM on final committed transcript, not partial preemptives
      turnHandling: {
        endpointing: {
          mode: 'fixed' as any,
          minDelay: 500,    // Wait 500ms after STT commits before generating reply
          maxDelay: 2000,   // Force end-of-turn after 2s to prevent hangs
        },
      },
    })

    return { session, agent }
  }

  // ============================================================
  // REALTIME MODE - OpenAI/Gemini native speech-to-speech
  // ============================================================

  // Claude handler for realtime mode tool execution
  let realtimeClaudeHandler: ReturnType<typeof createClaudeLLM> | null = null

  // Create REALTIME session (OpenAI/Gemini native speech-to-speech)
  async function createRealtimeSession(sessionRealtimeConfig?: typeof realtimeConfig, resumeSessionId?: string): Promise<{ session: voice.AgentSession; agent: voice.Agent }> {
    const rtConfig = sessionRealtimeConfig || realtimeConfig
    console.log(`🎯 Creating realtime session (${rtConfig.provider})...`)

    // Create Claude LLM for tool execution (research tasks)
    realtimeClaudeHandler = createClaudeLLM({
      workingDirectory: workingDir,
      sessionBaseDir,
      mcpServers,
      resumeSessionId,
      onCompactionEvent: (event) => {
        try {
          // Forward every field — frontend renders stage + detail + skill list during compaction.
          // Spread covers compaction_started/progress/complete (different fields per type).
          sendToFrontend({ ...event } as any)
        } catch { /* non-fatal */ }
      },
    })
    currentLLM = realtimeClaudeHandler

    // For resumed sessions, eagerly create workspace (we know the real ID)
    if (resumeSessionId) {
      const workspace = ensureSessionWorkspace(workingDir, resumeSessionId)
      console.log(`📁 Session workspace (resumed): ${workspace}`)
    }

    // For new sessions, create workspace when SDK assigns real session ID
    realtimeClaudeHandler.events.once('session_id', ({ sessionId }: { sessionId: string }) => {
      const workspace = ensureSessionWorkspace(workingDir, sessionId)
      console.log(`📁 Session workspace created: ${workspace}`)
    })

    // Wire up MCP server changes to frontend
    realtimeClaudeHandler.events.on('mcp_servers_changed', (data) => {
      console.log(`🔌 MCP servers changed: ${data.enabledKeys.join(', ') || 'none'}`)
      sendToFrontend({
        type: 'mcp_servers_changed',
        enabledKeys: data.enabledKeys,
        mcpServers: getMcpServerStatusList(config),
      })
    })

    // Wire up Claude events to frontend
    realtimeClaudeHandler.events.on('tool_use', (data) => {
      console.log(`🔧 Claude: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, agentRole: 'realtime' })
    })

    realtimeClaudeHandler.events.on('tool_result', (data) => {
      console.log(`✅ Done: ${data.name}`)
      sendToFrontend({ type: 'tool_use', tool: data.name, status: 'completed', agentRole: 'realtime' })

      // Detect research artifact writes (session workspace or legacy research dir)
      if ((data.name === 'Write' || data.name === 'Edit') && data.input?.file_path) {
        const fp = data.input.file_path
        if (fp.includes('/osb/') || fp.includes('.osborn/sessions/') || fp.includes('.osborn/research/')) {
          sendToFrontend({
            type: 'research_artifact_updated',
            filePath: fp,
            fileName: fp.split('/').pop(),
          })
        }
      }
    })

    realtimeClaudeHandler.events.on('assistant_result', (data) => {
      console.log(`📋 Claude result (${data.text?.length || 0} chars): ${data.text || ''}`)
      sendToFrontend({
        type: 'claude_output',
        text: data.text,
        isStreaming: false,
        isFinal: true,
        agentRole: 'realtime',
      })
    })

    // Stream Claude's research text to frontend as progress updates
    // Skips during active research to avoid duplication with per-task onText handler
    realtimeClaudeHandler.events.on('assistant_text', (data) => {
      if (data.text && data.text.trim()) {
        if (activeResearch) return
        sendToFrontend({
          type: 'claude_output',
          text: data.text,
          isStreaming: true,
          agentRole: 'realtime-agent',
        })
      }
    })

    realtimeClaudeHandler.events.on('permission_request', (data) => {
      console.log(`⚠️ Permission needed: ${data.toolName}`)
      const toolName = data.toolName
      const input = data.input || {}

      // Build descriptive message based on tool type
      let description = `I need permission to use ${toolName}.`
      if (toolName === 'Bash' && input.command) {
        const cmd = String(input.command).substring(0, 60)
        description = `I want to run the command: ${cmd}${String(input.command).length > 60 ? '...' : ''}`
      } else if (toolName === 'Write' && input.file_path) {
        description = `I want to create or overwrite the file: ${input.file_path}`
      } else if (toolName === 'Edit' && input.file_path) {
        description = `I want to edit the file: ${input.file_path}`
      } else if (toolName === 'WebFetch' && input.url) {
        description = `I want to fetch content from: ${input.url}`
      }

      sendToFrontend({
        type: 'permission_request',
        toolName: data.toolName,
        input: data.input,
        description,
        agentRole: 'realtime',
      })
    })

    // Wire up session resume failure for realtime mode
    realtimeClaudeHandler.events.on('session_resume_failed', (data) => {
      console.error(`❌ Session resume failed: ${data.requestedSessionId} → ${data.actualSessionId}`)
      sendToFrontend({
        type: 'session_resume_failed',
        requestedSessionId: data.requestedSessionId,
        actualSessionId: data.actualSessionId,
      })
    })

    // Wire up file checkpoint capture for realtime mode
    realtimeClaudeHandler.events.on('checkpoint_captured', (data) => {
      console.log(`📍 Checkpoint: ${data.checkpointId.substring(0, 8)}...`)
      sendToFrontend({
        type: 'checkpoint_captured',
        checkpointId: data.checkpointId,
      })
    })


    // Extracted research execution — called by ask_agent, SDK handles queuing internally
    function executeResearch(task: string): string {
      sendToFrontend({ type: 'system', text: `Executing: ${task}` })

      // Fire-and-forget: write user question to spec.md BEFORE agent starts
      const questionSid = currentLLM?.sessionId || resumeSessionId
      if (questionSid) {
        writeQuestionToSpec(workingDir, questionSid, task).catch(err =>
          console.error('❌ writeQuestionToSpec failed:', err)
        )
      }

      // Clean up previous research UI tracking — but let the SDK query complete in background.
      // The SDK has an internal queue: new query() calls enqueue behind running ones.
      // Old research results land in JSONL and fast brain can access them later.
      if (activeResearch) {
        activeResearch.cleanup() // Remove event listeners so UI tracks new task
        if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
        // NOTE: NOT aborting — old SDK process continues writing to JSONL
      }

      // Set up research log batching — events push to queue for state-driven injection
      const researchLog: string[] = []
      const pendingUpdates: string[] = []
      const onToolUse = (data: any) => {
        const input = data.input || {}
        let entry: string

        if (data.name === 'Read' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Reading ${fileName}`
        } else if (data.name === 'Bash' && input.command) {
          const cmd = input.command.substring(0, 80)
          entry = `Running: ${cmd}`
        } else if (data.name === 'Glob' && input.pattern) {
          entry = `Searching for files matching ${input.pattern}`
        } else if (data.name === 'Grep' && input.pattern) {
          entry = `Searching for "${input.pattern}" in files`
        } else if (data.name === 'WebSearch' && input.query) {
          entry = `Searching the web for "${input.query}"`
        } else if (data.name === 'WebFetch' && input.url) {
          const hostname = input.url.replace(/https?:\/\//, '').split('/')[0]
          entry = `Fetching content from ${hostname}`
        } else if (data.name === 'Write' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Writing ${fileName}`
        } else if (data.name === 'Edit' && input.file_path) {
          const fileName = input.file_path.split('/').pop() || input.file_path
          entry = `Editing ${fileName}`
        } else if (data.name.startsWith('mcp__')) {
          const parts = data.name.split('__')
          const serverName = parts[1] || 'external'
          const toolAction = parts.slice(2).join(' ') || 'tool'
          entry = `Using ${serverName}: ${toolAction}`
        } else {
          entry = `Using ${data.name}`
        }

        researchLog.push(entry)
        pendingUpdates.push(entry)
        scheduleResearchBatch()
      }
      const ANSWER_CHECK_THRESHOLD = 300 // chars — only check substantial outputs
      const onToolResult = (data: any) => {
        // Only log to researchLog for the final summary — don't push to pendingUpdates
        // This prevents redundant "Reading config.ts. Read done." voice updates
        researchLog.push(`${data.name} completed`)
        // Fire-and-forget: check if substantial tool results answer any spec questions
        // Note: PostToolUse emits { name, input, response } — use data.response (not data.result)
        const resultText = typeof data.response === 'string' ? data.response : JSON.stringify(data.response || '')
        if (resultText.length > ANSWER_CHECK_THRESHOLD) {
          const sid = currentLLM?.sessionId || resumeSessionId
          if (sid) checkOutputAgainstQuestions(workingDir, sid, resultText, 'tool_result').catch(() => {})
        }
        // When AskUserQuestion completes, the user's answer is a decision — track it in spec
        if (data.name === 'AskUserQuestion' && data.response) {
          const sid = currentLLM?.sessionId || resumeSessionId
          if (sid) {
            const questionText = JSON.stringify(data.input?.questions || data.input || {})
            const answerText = typeof data.response === 'string' ? data.response : JSON.stringify(data.response)
            const specUpdate = `User answered a clarifying question during research.\nQuestion: ${questionText}\nAnswer: ${answerText}\nRecord this as a user decision in spec.md.`
            askHaiku(workingDir, sid, specUpdate, undefined, undefined, undefined, workingDir).catch(err =>
              console.error('❌ Failed to record AskUserQuestion answer in spec:', err)
            )
            console.log(`📝 AskUserQuestion answer forwarded to fast brain for spec tracking`)
          }
        }
      }
      const onText = (data: any) => {
        if (data.text?.trim()) {
          const text = data.text.trim()
          const preview = text.substring(0, 150)
          const firstSentence = preview.match(/^[^.!?\n]+[.!?]/)?.[0] || preview
          researchLog.push(firstSentence)
          pendingUpdates.push(firstSentence)
          scheduleResearchBatch()
          // Fire-and-forget: check if substantial agent reasoning answers any spec questions
          if (text.length > ANSWER_CHECK_THRESHOLD) {
            const sid = currentLLM?.sessionId || resumeSessionId
            if (sid) checkOutputAgainstQuestions(workingDir, sid, text, 'assistant_text').catch(() => {})
          }
        }
      }
      // Capture the SDK's requestId for this query — identifies this research task
      // in the JSONL file for targeted retrieval by fast brain
      let sdkRequestId: string | null = null
      const onQueryRequestId = (data: any) => {
        if (!sdkRequestId && data.requestId) {
          sdkRequestId = data.requestId
          console.log(`📋 [research] SDK requestId: ${sdkRequestId}`)
        }
      }
      realtimeClaudeHandler!.events.on('tool_use', onToolUse)
      realtimeClaudeHandler!.events.on('tool_result', onToolResult)
      realtimeClaudeHandler!.events.on('assistant_text', onText)
      realtimeClaudeHandler!.events.on('query_request_id', onQueryRequestId)

      const cleanupListeners = () => {
        realtimeClaudeHandler?.events.off('tool_use', onToolUse)
        realtimeClaudeHandler?.events.off('tool_result', onToolResult)
        realtimeClaudeHandler?.events.off('assistant_text', onText)
        realtimeClaudeHandler?.events.off('query_request_id', onQueryRequestId)
      }

      // Create AbortController for this research task — abort on disconnect/cleanup
      const researchAbortController = new AbortController()

      // Track active research — updates drain when model enters 'listening' state
      const thisResearch = {
        researchLog,
        pendingUpdates,
        cleanup: cleanupListeners,
        voiceUpdateCount: 0,
        abortController: researchAbortController,
      }
      activeResearch = thisResearch

      // Start proactive conversational loop
      const proactiveSid = currentLLM?.sessionId || resumeSessionId
      if (proactiveSid) {
        startProactiveLoop(task, proactiveSid)
      }

      // Run research in the background (non-blocking)
      // Pass AbortController so research can be stopped on disconnect
      const researchPromise = (async () => {
        const stream = realtimeClaudeHandler!.chat({
          chatCtx: {
            items: [{ type: 'message', role: 'user', content: [task] }],
          } as any,
          abortController: researchAbortController,
        })

        let result = ''
        for await (const chunk of stream) {
          if (chunk.delta?.content) {
            result += chunk.delta.content
          }
        }
        return result
      })()

      // Handle completion asynchronously
      researchPromise.then(async (result) => {
        // Check if aborted — empty result means clean abort, skip pipeline
        if (researchAbortController.signal.aborted || !result.trim()) {
          console.log(`🛑 [realtime] Research aborted or empty: ${task.substring(0, 60)}`)
          cleanupListeners()
          if (activeResearch === thisResearch) {
            activeResearch = null
          }
          return
        }

        const isStillCurrent = activeResearch === thisResearch
        console.log(`✅ [realtime] Research complete (${result.length} chars${isStillCurrent ? '' : ', superseded by newer task'})`)

        // Clean up
        cleanupListeners()

        // Send raw result to frontend as a log entry (not assistant_response — that's reserved
        // for the voice model's spoken response, avoiding duplication in chat)
        await sendToFrontend({ type: 'claude_output', text: result, isStreaming: false, agentRole: 'research-result' })
        const resultPreview = result.length > 150
          ? result.substring(0, 150) + '...'
          : result
        await sendToFrontend({ type: 'task_completed', task, resultPreview })

        // Only modify global state if we're still the current research task.
        // If a newer task replaced us, don't clobber its timers/state.
        if (isStillCurrent) {
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
        }

        // Preserve research context for follow-up questions
        lastCompletedResearch = {
          task,
          researchLog: [...researchLog],
          completedAt: Date.now(),
        }

        // Only clear activeResearch if we're still the current task
        if (isStillCurrent) {
          activeResearch = null
        }

        // Send research_task_complete to frontend for inline chat tracking
        await sendToFrontend({
          type: 'research_task_complete',
          task,
          summary: result.substring(0, 500),
        })

        // Route through fast brain to generate a teleprompter script from the findings
        // Fast brain reads full JSONL and writes a spoken monologue
        const voiceSid = currentLLM?.sessionId || resumeSessionId
        const chatHistory = getChatHistory(10)
        console.log(`📡 [realtime] Generating teleprompter script via fast brain (result: ${result.length} chars, agentState: ${agentState})`)
        // Create sendToChat for research completion to send structured data to frontend
        const completionSendToChat = (text: string) => {
          sendToFrontend({ type: 'assistant_response', text })
        }
        if (voiceSid) {
          processResearchCompletion(workingDir, voiceSid, task, result, chatHistory, completionSendToChat, workingDir)
            .then(script => {
              queueVoiceInjection(getScriptInjection(script))
            })
            .catch(() => {
              // Fallback: use truncated result directly if fast brain fails
              queueVoiceInjection(getScriptInjection(result.substring(0, 500)))
            })
        } else {
          queueVoiceInjection(getScriptInjection(result.substring(0, 500)))
        }

        // Fire-and-forget JSONL-based refinement pass via fast brain
        // Reads FULL untruncated data from JSONL — no content buffer, no truncation
        const postResearchSessionId = currentLLM?.sessionId || resumeSessionId
        if (postResearchSessionId) {
          updateSpecFromJSONL(workingDir, postResearchSessionId, task, researchLog, workingDir)
            .then(updateResult => {
              if (!updateResult) return

              // Notify frontend about spec.md update
              if (updateResult.spec) {
                const specPath = join(getSessionWorkspace(workingDir, postResearchSessionId), 'spec.md')
                sendToFrontend({
                  type: 'research_artifact_updated',
                  filePath: specPath,
                  fileName: 'spec.md',
                })
              }
            })
        }
      }).catch(async (err) => {
        // Clean up
        cleanupListeners()
        const isStillCurrent = activeResearch === thisResearch
        if (isStillCurrent) {
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
          activeResearch = null
        }

        // If aborted (user disconnected), log quietly
        if (researchAbortController.signal.aborted) {
          console.log(`🛑 [realtime] Research aborted: ${task.substring(0, 60)}`)
          return
        }

        console.error(`❌ [realtime] Research failed:`, err)
        // Queue error notification — will be spoken when model is available
        queueVoiceInjection(getNotificationInjection(`Research encountered an error: ${(err as Error).message}. You could try asking again.`))
      })

      // Return immediately to unblock the voice model
      return 'Research started. I\'ll relay findings as they come in — you can keep talking to the user while I work.'
    }

    // Create tools for the realtime voice LLM
    // The realtime model is a thin teleprompter — only 2 tools:
    // 1. ask_fast_brain: ALL user questions route here (the fast brain decides everything)
    // 2. respond_permission: voice permission flow for Claude SDK blocked operations

    const askFastBrainTool = llm.tool({
      description: `Ask your brain. Call this for EVERY user message — greetings, questions, decisions, requests, everything. No exceptions. Returns what you should say.`,
      parameters: z.object({
        question: z.string().describe('The user\'s question or statement'),
      }),
      execute: async ({ question }) => {
        // INJECTION BYPASS: When Gemini receives a system injection via generateReply(),
        // it calls ask_fast_brain with the injection content (Gemini always calls tools).
        // For Gemini: this is the INTENDED path — we deliberately don't set toolChoice:'none'
        //   so the tool call goes through and we return the content as a tool response.
        // For OpenAI: this is a fallback guard — OpenAI normally speaks instructions directly
        //   with toolChoice:'none', but if it somehow calls the tool, we handle it here.
        const injectionMatch = question.match(/\[(SCRIPT|PROACTIVE|NOTIFICATION)\]\s*([\s\S]*)/)
        if (injectionMatch) {
          const content = injectionMatch[2].trim()
          console.log(`⚡ [fast brain] BYPASS: injection [${injectionMatch[1]}] → returning content directly (${content.length} chars)`)
          return content || question
        }

        // Use pending sessionId for fresh sessions where SDK hasn't assigned one yet
        const sessionId = currentLLM?.sessionId || currentResumeSessionId || resumeSessionId || 'pending'
        console.log(`🧠 [fast brain] Question: "${question.substring(0, 80)}..."`)

        // Track in-flight state
        haikuInFlight = { question, time: Date.now() }

        // Build research context — from active research or last completed research
        let researchContext: string | undefined
        if (activeResearch && activeResearch.researchLog.length > 0) {
          const recentLog = activeResearch.researchLog.slice(-15)
          researchContext = `Research topic: "${lastTaskRequest || 'unknown'}"\nSteps completed (${activeResearch.researchLog.length} total, showing last ${recentLog.length}):\n${recentLog.join('\n')}`
        } else if (lastCompletedResearch && (Date.now() - lastCompletedResearch.completedAt) < 600000) {
          // Include context from last completed research (within 10 minutes)
          const recentLog = lastCompletedResearch.researchLog.slice(-15)
          researchContext = `[COMPLETED RESEARCH] Topic: "${lastCompletedResearch.task}"\nSteps completed (${lastCompletedResearch.researchLog.length} total, showing last ${recentLog.length}):\n${recentLog.join('\n')}\n\n(Research completed — results are in JSONL and spec.md. Answer from those, do NOT trigger new research on this topic.)`
        }

        const callbacks: FastBrainCallbacks = {
          triggerResearch: (task: string) => {
            // Deduplication guard
            const now = Date.now()
            if (task === lastTaskRequest && (now - lastTaskTime) < 10000) {
              console.log('⏭️ Skipping duplicate research task (within 10s window)')
              return
            }
            lastTaskRequest = task
            lastTaskTime = now
            executeResearch(task)
          },
          queueVoice: (script: string) => {
            queueVoiceInjection(getScriptInjection(script))
          },
          sendToFrontend: (data: any) => {
            sendToFrontend(data)
          },
        }

        try {
          const chatHistory = getChatHistory(20)
          const result = await askFastBrain(workingDir, sessionId, question, {
            chatHistory,
            researchContext,
            callbacks,
          })
          haikuInFlight = null
          // Voice queue items may have been held while fast brain was in flight — retry now
          if (voiceQueue.length > 0) {
            setTimeout(() => processVoiceQueue(), 500)
          }

          console.log(`🧠 [fast brain] Response type: ${result.type}, script: ${result.script.length} chars`)

          // If this was a user direction during active research,
          // pass it to the agent SDK so it picks up the context
          if (activeResearch && result.type === 'recorded' && (
            question.toLowerCase().includes('decided') ||
            question.toLowerCase().includes('prefers') ||
            question.toLowerCase().includes('focus on') ||
            question.toLowerCase().includes('redirect')
          )) {
            console.log(`📨 [fast brain] Passing user direction to agent SDK queue`)
            executeResearch(`[USER DIRECTION during active research] ${question}. The user's spec.md has been updated. Acknowledge briefly and incorporate.`)
          }

          return result.script
        } catch (err) {
          haikuInFlight = null
          // Voice queue items may have been held while fast brain was in flight — retry now
          if (voiceQueue.length > 0) {
            setTimeout(() => processVoiceQueue(), 500)
          }
          console.error('❌ Fast brain failed:', err)
          return 'I\'m having trouble processing that. Could you try again?'
        }
      },
    })

    const respondPermissionTool = llm.tool({
      description: `Respond to a permission request. Call after hearing user's response.`,
      parameters: z.object({
        response: z.enum(['allow', 'deny', 'always_allow']),
      }),
      execute: async ({ response }) => {
        if (!realtimeClaudeHandler?.hasPendingPermission()) {
          return 'No pending permission.'
        }
        const pending = realtimeClaudeHandler.getPendingPermission()
        const allow = response === 'allow' || response === 'always_allow'
        realtimeClaudeHandler.respondToPermission(allow)
        await sendToFrontend({ type: 'permission_response', response, toolName: pending?.toolName })
        return `Permission ${response} for ${pending?.toolName || 'tool'}.`
      },
    })

    // Instructions for realtime voice LLM
    const realtimeInstructions = getRealtimeInstructions(workingDir)

    // Create realtime model
    const realtimeModel = createRealtimeModelFromConfig(rtConfig, realtimeInstructions)

    // Create the Agent with MINIMAL tools — fast brain handles all routing
    const agent = new voice.Agent({
      instructions: realtimeInstructions,
      llm: realtimeModel,
      tools: {
        ask_fast_brain: askFastBrainTool,
        respond_permission: respondPermissionTool,
      },
    })

    // Create the session
    const session = new voice.AgentSession({})

    return { session, agent }
  }

  // ============================================================
  // Room Event Handlers
  // ============================================================

  room.on(RoomEvent.Connected, () => {
    console.log('✅ Connected to room:', roomName)
    localParticipant = room.localParticipant
  })

  room.on(RoomEvent.Disconnected, () => {
    console.log('👋 Disconnected from room')
    // Clean up active research and voice queue
    voiceQueue.length = 0
    isProcessingQueue = false
    currentSpeechHandle = null
    lastInterruption = null

    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    stopProactiveLoop()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }
    lastCompletedResearch = null
    currentSession = null
    currentAgent = null
    // Same disconnect-leak fix as the other two cleanup sites — kill the Claude SDK
    // subprocess BEFORE dropping the reference. See killCurrentLLM() for full context.
    killCurrentLLM('disconnected_cleanup')
    currentLLM = null
    clearFastBrainSession()
    clearPipelineFastBrainSession()
  })

  room.on(RoomEvent.ParticipantConnected, async (participant: RemoteParticipant) => {
    console.log(`\n👤 User joined: ${participant.identity}`)

    // Wait for previous session's byte stream handler to fully deregister.
    // Quick reconnects (< ~6s) crash with "byte stream handler already set" without this.
    if (pendingSessionClose) {
      console.log('⏳ Waiting for previous session to fully close...')
      await pendingSessionClose
    }

    // Clean up any existing session before creating a new one
    voiceQueue.length = 0
    isProcessingQueue = false
    currentSpeechHandle = null
    lastInterruption = null

    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    stopProactiveLoop()
    clearFastBrainSession()
    clearPipelineFastBrainSession()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }
    lastCompletedResearch = null
    if (currentSession) {
      console.log('🧹 Cleaning up previous session...')
      try {
        await currentSession.close()
      } catch {}
      try {
        currentSession.removeAllListeners()
      } catch {}
      currentSession = null
      currentAgent = null
      // Same disconnect-leak fix — kill the previous user's Claude subprocess
      // before binding currentLLM to the new user's session below.
      killCurrentLLM('previous_session_cleanup')
      currentLLM = null
    }

    // Extract voice architecture, provider, and sessionId from participant metadata (sent by frontend)
    // This overrides the config file setting for per-session flexibility
    let sessionVoiceMode: VoiceMode = voiceMode  // Default to config
    let sessionRealtimeProvider: 'gemini' | 'openai' = realtimeConfig.provider  // Default to config
    let preSelectedSessionId: string | null = null
    try {
      const metadata = JSON.parse(participant.metadata || '{}')
      console.log(`📋 Participant metadata:`, metadata)
      // userId from authenticated Supabase session — used to scope Supabase
      // Storage uploads so each user's workspace artifacts live under their
      // own prefix. Falls through to '' (anonymous) if not authenticated.
      if (typeof metadata.userId === 'string' && metadata.userId.length > 0) {
        currentUserId = metadata.userId
      } else {
        currentUserId = ''
      }
      if (metadata.voiceArch === 'realtime' || metadata.voiceArch === 'direct' || metadata.voiceArch === 'pipeline') {
        sessionVoiceMode = metadata.voiceArch
        console.log(`🎙️ Using voice mode from frontend: ${sessionVoiceMode}`)
      } else if (metadata.voiceArch) {
        console.log(`⚠️ Unknown voiceArch "${metadata.voiceArch}", using config: ${voiceMode}`)
      }
      // Read provider selection from frontend (openai or gemini)
      if (metadata.provider === 'openai' || metadata.provider === 'gemini') {
        sessionRealtimeProvider = metadata.provider
        console.log(`🎙️ Using provider from frontend: ${sessionRealtimeProvider}`)
      }
      // Read pre-selected session ID from frontend (session browser selection)
      if (metadata.sessionId && typeof metadata.sessionId === 'string' && metadata.sessionId.length > 0) {
        preSelectedSessionId = metadata.sessionId
        console.log(`📂 Pre-selected session from frontend: ${preSelectedSessionId}`)
      }
      // Read working directory override from frontend.
      //
      // If the path doesn't exist yet (new project on first use, or freshly
      // imported sessions on a new sprite), create it with mkdirSync so the
      // agent can accept it. This is safe: recursive mkdirSync is a no-op when
      // the directory already exists, and project paths always live under the
      // workspace root. The Claude SDK child_process.spawn requires the cwd to
      // exist — mkdirSync satisfies that requirement without silently falling back.
      if (metadata.workingDirectory && typeof metadata.workingDirectory === 'string' && metadata.workingDirectory.length > 0) {
        if (!existsSync(metadata.workingDirectory)) {
          mkdirSync(metadata.workingDirectory, { recursive: true })
          console.log(`📁 Created project directory: ${metadata.workingDirectory}`)
        }
        workingDir = metadata.workingDirectory
        console.log(`📂 Working directory from frontend: ${workingDir}`)
      } else {
        // Reset to default for new connections (in case previous session changed it)
        workingDir = defaultWorkingDir
      }
    } catch (err) {
      console.log('⚠️ Could not parse participant metadata, using config voiceMode:', voiceMode)
    }

    // Sync to outer scope so DataReceived handler can use it
    currentVoiceMode = sessionVoiceMode
    currentProvider = sessionRealtimeProvider

    // Resume session ID — only set when resuming an existing session
    const resumeSessionId = preSelectedSessionId || undefined
    currentResumeSessionId = resumeSessionId
    if (resumeSessionId) {
      console.log(`🆔 Resuming session: ${resumeSessionId}`)
    } else {
      console.log(`🆔 New session (ID assigned by SDK)`)
    }

    // Ensure Claude is authenticated before creating voice session
    // In cloud deployments (Fly.io), this triggers OAuth flow on first boot:
    // captures login URL → sends to frontend → user clicks → gets code → pastes in frontend → auth completes
    try {
      const authResult = await ensureClaudeAuth((type, payload) => {
        sendToFrontend({ type, ...payload as object })
      })
      // If auth flow is running, store the submitCode handler for the DataReceived handler
      if (authResult.submitCode && authResult.done) {
        pendingAuthSubmitCode = authResult.submitCode
        await authResult.done
        pendingAuthSubmitCode = null
      }
    } catch (err: any) {
      console.error('❌ Claude authentication failed:', err?.message)
      sendToFrontend({ type: 'claude_auth_error', message: err?.message || 'Authentication failed' })
      pendingAuthSubmitCode = null
      // Continue anyway — the agent SDK will use ANTHROPIC_API_KEY if available
    }

    // Create session based on voice mode (from frontend or config)
    let session: voice.AgentSession
    let agent: voice.Agent

    if (sessionVoiceMode === 'realtime') {
      // Override the config provider with the frontend's selection
      const sessionRealtimeConfig = { ...realtimeConfig, provider: sessionRealtimeProvider }
      console.log(`🎙️ REALTIME MODE: ${sessionRealtimeConfig.provider} native speech-to-speech`)
      const result = await createRealtimeSession(sessionRealtimeConfig, resumeSessionId)
      session = result.session
      agent = result.agent
    } else if (sessionVoiceMode === 'pipeline') {
      console.log(`🎯 PIPELINE MODE: Claude SDK + parallel Gemini fast brain observer`)
      // Pipeline mode = direct mode underneath + parallel fast brain
      // Fast brain runs in PipelineDirectLLM.chat() — fires Gemini alongside Claude
      const { createPipelineDirectLLM } = await import('./pipeline-direct-llm.js')
      const pipelineLLM = createPipelineDirectLLM({
        workingDirectory: workingDir,
        sessionBaseDir,
        mcpServers,
        resumeSessionId,
        voiceMode: 'direct',
        skipTTSQueue: true,
        getChatHistory: () => getChatHistory(20).map(t => ({ role: t.role, content: t.text })),
        getResearchContext: () => {
          if (activeResearch?.researchLog.length) {
            return `Research: "${lastTaskRequest}"\n${activeResearch.researchLog.slice(-15).join('\n')}`
          }
          if (lastCompletedResearch && Date.now() - lastCompletedResearch.completedAt < 600000) {
            return `[COMPLETED] "${lastCompletedResearch.task}"\n${lastCompletedResearch.researchLog.slice(-15).join('\n')}`
          }
        },
        getAndConsumeInterruptionContext,
        onFastBrainResult: (result) => {
          console.log(`🧠⚡ [FAST_BRAIN ${result.type.toUpperCase()} +${result.elapsedMs}ms]: "${result.answer.substring(0, 60)}"`)
          sendToFrontend({
            type: 'fast_brain_response',
            text: result.answer,
            responseType: result.type,
            elapsedMs: result.elapsedMs,
            question: result.question,
            toolsUsed: result.toolsUsed,
            agentRole: 'pipeline-fast-brain',
          })
        },
      })
      // Pass pipelineLLM to createDirectSession so it uses it instead of creating a new ClaudeLLM
      const result = await createDirectSession(resumeSessionId, pipelineLLM)
      session = result.session
      agent = result.agent
    } else {
      console.log(`🎯 DIRECT MODE: Claude Agent SDK with full coding capabilities`)
      const result = await createDirectSession(resumeSessionId)
      session = result.session
      agent = result.agent
    }
    currentSession = session
    currentAgent = agent  // Store for updateChatCtx() context injection

    // ============================================================
    // Session event wiring — extracted into function for auto-recovery
    // ============================================================
    let lastRecoveryTime = 0
    const MIN_RECOVERY_INTERVAL = 3000  // 3 seconds between recovery attempts

    function wireSessionEvents(sess: voice.AgentSession, agt: voice.Agent) {
      // Transcript dedup state (reset per wiring)
      let lastSentUserTranscript = ''
      let lastSentAgentTranscript = ''

      function sendUserTranscript(transcript: string, source: string) {
        if (!transcript || transcript.length < 3) return
        const normalized = transcript.trim().replace(/\s+/g, ' ')
        if (normalized === lastSentUserTranscript) return
        if (normalized === '<noise>' || normalized.toLowerCase() === 'thank you') return
        // Filter out voice injection content that appears as user transcript
        // (Gemini v1.0.51: userInput in generateReply creates a user conversation item)
        if (normalized.startsWith('[SCRIPT]') || normalized.startsWith('[PROACTIVE]') || normalized.startsWith('[NOTIFICATION]')) return

        console.log(`📝 User (${source}, ${transcript.length} chars): "${transcript}"`)
        sendToFrontend({ type: 'user_transcript', text: transcript })
        lastSentUserTranscript = normalized
      }

      function sendAgentTranscript(text: string, source: string) {
        if (!text || text.length < 3) return
        const normalized = text.trim().replace(/\s+/g, ' ')
        if (normalized === lastSentAgentTranscript) return

        console.log(`💬 Agent (${source}, ${text.length} chars): "${text}"`)
        sendToFrontend({ type: 'assistant_response', text })
        lastSentAgentTranscript = normalized
      }

      // PRIMARY: conversation_item_added is the authoritative source
      sess.on('conversation_item_added' as any, (ev: any) => {
        let text = ''
        if (Array.isArray(ev.item?.content)) {
          text = typeof ev.item.content[0] === 'string'
            ? ev.item.content.join('\n')
            : ev.item.content.map((c: any) => c.text).filter(Boolean).join('\n')
        } else if (typeof ev.item?.content === 'string') {
          text = ev.item.content
        } else if (ev.item?.text) {
          text = ev.item.text
        }

        if (ev.item?.role === 'user' && text) {
          sendUserTranscript(text, 'conv_item')
        } else if (ev.item?.role === 'assistant' && text) {
          sendAgentTranscript(text, 'conv_item')
        }
      })

      // FALLBACK: user_speech_committed
      sess.on('user_speech_committed' as any, (ev: any) => {
        const transcript = ev.transcript || ev.text || ''
        sendUserTranscript(transcript, 'committed')
      })

      // Agent state tracking
      sess.on('agent_state_changed' as any, (ev: any) => {
        agentState = ev.newState
        // Clear processing guard when model transitions to any new state
        isProcessingQueue = false
        console.log(`🤖 State: ${ev.newState}`)
        sendToFrontend({ type: 'agent_state', state: ev.newState })

        // When the model becomes available (listening), process any queued voice injections
        if (ev.newState === 'listening' && voiceQueue.length > 0) {
          setTimeout(() => processVoiceQueue(), 500)  // 500ms to let model settle
        }
      })

      // User state tracking — prevents queue from colliding with server-side VAD
      sess.on('user_state_changed' as any, (ev: any) => {
        userState = ev.newState
        console.log(`👤 User state: ${ev.newState}`)
        // When user stops speaking, retry voice queue — items may be waiting
        if (ev.newState === 'listening' && voiceQueue.length > 0) {
          setTimeout(() => processVoiceQueue(), 500)
        }
      })


      // FALLBACK: playout_completed
      sess.on('playout_completed' as any, (ev: any) => {
        const message = ev.message || ev.text || ev.content
        if (message && message.length > 0) {
          sendAgentTranscript(message, 'playout')
        }
      })

      // Error handler
      sess.on('error' as any, (ev: any) => {
        const msg = ev.error?.message || String(ev.error)
        // OpenAI race: voice queue collided with server-side VAD auto-response
        if (msg.includes('conversation_already_has_active_response') || msg.includes('active_response')) {
          console.log('⚠️ OpenAI active response collision — queue will retry on next listening state')
          return
        }
        // TTS abort from user interruption is normal — not an error
        if (msg.includes('Request was aborted') || msg.includes('APIUserAbortError') || msg.includes('aborted')) {
          console.log('⚠️ LLM request aborted (user interrupted)')
          return
        }
        console.error('❌ Session error:', ev.error)
      })

      // Capture voice mode at session creation — prevents state confusion
      // if currentVoiceMode changes between session start and crash recovery
      const sessionVoiceMode = currentVoiceMode

      // Close handler with auto-recovery for crashes (both realtime and direct modes)
      sess.on('close' as any, async (ev: any) => {
        console.log('🚪 Session closed:', ev.reason)

        // TTS abort from user interruption — SDK already killed the session internally,
        // so we MUST recover (can't just reset state — STT pipeline is dead).
        // Log it distinctly so we know it's an interrupt recovery, not a real crash.
        const errorMsg = ev.error?.message || ev.error?.error?.message || ''
        const isTTSAbort = errorMsg.includes('aborted') || errorMsg.includes('APIUserAbortError')
        if (isTTSAbort) {
          console.log('⚠️ TTS abort from user interruption — recovering session (SDK killed it internally)')
        }

        // Auto-recover from crashes in direct/pipeline mode (includes TTS abort)
        if ((ev.reason === 'error' || ev.reason === 'disconnected') && (sessionVoiceMode === 'direct' || sessionVoiceMode === 'pipeline')) {
          const now = Date.now()
          if (now - lastRecoveryTime < MIN_RECOVERY_INTERVAL) {
            console.log(`⚠️ Recovery too frequent — scheduling retry in ${MIN_RECOVERY_INTERVAL}ms`)
            setTimeout(async () => {
              // Re-check: if session was already recovered or user left, skip
              if (currentSession || !room.remoteParticipants.size) return
              console.log('🔄 Retrying direct mode recovery after guard interval...')
              // Trigger recovery by emitting a synthetic close
              sess.emit('close' as any, { reason: 'error' })
            }, MIN_RECOVERY_INTERVAL)
            return
          }
          lastRecoveryTime = now

          console.log(`🔄 Auto-recovering direct mode session (reason: ${ev.reason})...`)

          // Clean up dead session — match realtime recovery's thoroughness
          try { sess.removeAllListeners() } catch {}
          currentSession = null
          currentAgent = null

          // Clear stale state from crashed session
          voiceQueue.length = 0
          isProcessingQueue = false
          haikuInFlight = null
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
          if (activeResearch) { activeResearch.abortController.abort(); activeResearch.cleanup(); activeResearch = null }

          try {
            // Reuse existing session ID so Claude SDK resumes where it left off
            const recoverySessionId = currentLLM?.sessionId || resumeSessionId

            // Stop old index watcher if it exists
            if (currentLLM && 'stopIndexWatcher' in currentLLM) {
              (currentLLM as any).stopIndexWatcher()
            }

            let result
            if (sessionVoiceMode === 'pipeline') {
              // Pipeline mode: recreate PipelineDirectLLM wrapper with fast brain
              console.log('🔄 Rebuilding pipeline mode (PipelineDirectLLM + fast brain)...')
              const { createPipelineDirectLLM } = await import('./pipeline-direct-llm.js')
              const pipelineLLM = createPipelineDirectLLM({
                workingDirectory: workingDir,
                sessionBaseDir,
                mcpServers,
                resumeSessionId: recoverySessionId,
                voiceMode: 'direct',
                skipTTSQueue: true,
                getChatHistory: () => getChatHistory(20).map(t => ({ role: t.role, content: t.text })),
                getResearchContext: () => {
                  if (activeResearch?.researchLog.length) {
                    return `Research: "${lastTaskRequest}"\n${activeResearch.researchLog.slice(-15).join('\n')}`
                  }
                  if (lastCompletedResearch && Date.now() - lastCompletedResearch.completedAt < 600000) {
                    return `[COMPLETED] "${lastCompletedResearch.task}"\n${lastCompletedResearch.researchLog.slice(-15).join('\n')}`
                  }
                },
                getAndConsumeInterruptionContext,
                onFastBrainResult: (r) => {
                  console.log(`🧠⚡ [FAST_BRAIN ${r.type.toUpperCase()} +${r.elapsedMs}ms]: "${r.answer.substring(0, 60)}"`)
                  sendToFrontend({
                    type: 'fast_brain_response', text: r.answer, responseType: r.type,
                    elapsedMs: r.elapsedMs, question: r.question, toolsUsed: r.toolsUsed,
                    agentRole: 'pipeline-fast-brain',
                  })
                },
              })
              result = await createDirectSession(recoverySessionId, pipelineLLM)
            } else {
              result = await createDirectSession(recoverySessionId)
            }
            const newSession = result.session
            const newAgent = result.agent
            currentSession = newSession
            currentAgent = newAgent

            // Re-wire event listeners on the new session
            wireSessionEvents(newSession, newAgent)

            await newSession.start({ agent: newAgent, room })

            // Sync state
            agentState = 'listening'
            sendToFrontend({ type: 'agent_state', state: 'listening' })

            // Resume Claude session if one was active
            if (currentLLM?.sessionId) {
              currentLLM.setContinueSession(true)
            }

            console.log('✅ Direct mode auto-recovery complete')

            // Notify user via TTS
            try {
              const recoveredId = currentLLM?.sessionId || recoverySessionId
              if (recoveredId) {
                const conversationHistory = await getConversationHistory(recoveredId, workingDir, 10)
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareRecoveryScript(historyForScript)
                // Direct mode: use session.say() for recovery notification
                newSession.say(script, { allowInterruptions: true })
              } else {
                newSession.say('Voice session was briefly interrupted but I\'m back. What were we working on?', { allowInterruptions: true })
              }
            } catch (err) {
              console.log('⚠️ Failed to generate recovery script:', err)
              try { newSession.say('I\'m back after a brief interruption. What were we working on?', { allowInterruptions: true }) } catch {}
            }
          } catch (err) {
            console.error('❌ Direct mode auto-recovery failed:', err)
            sendToFrontend({ type: 'agent_state', state: 'error' })
          }
          return
        }

        // Auto-recover from crashes in realtime mode
        if (ev.reason === 'error' && sessionVoiceMode === 'realtime') {
          const now = Date.now()
          if (now - lastRecoveryTime < MIN_RECOVERY_INTERVAL) {
            console.log('⚠️ Recovery too frequent — skipping to prevent loop')
            sendToFrontend({ type: 'agent_state', state: 'error' })
            return
          }
          lastRecoveryTime = now

          console.log('🔄 Auto-recovering from session crash...')

          // Clean up dead session
          try { sess.removeAllListeners() } catch {}
          currentSession = null
          currentAgent = null

          // Clear voice queue — stale injections from the crashed session
          voiceQueue.length = 0
          isProcessingQueue = false
      
          if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
          stopProactiveLoop()
                if (activeResearch) { activeResearch.abortController.abort(); activeResearch.cleanup(); activeResearch = null }

          try {
            const recoveryConfig = { ...realtimeConfig, provider: currentProvider as 'gemini' | 'openai' }
            // Reuse existing session ID for workspace continuity during recovery
            // Prefer real SDK session ID, fall back to original resume ID
            const recoverySessionId = currentLLM?.sessionId || resumeSessionId
            const result = await createRealtimeSession(recoveryConfig, recoverySessionId)
            const newSession = result.session
            const newAgent = result.agent
            currentSession = newSession
            currentAgent = newAgent

            // Re-wire event listeners on the new session
            wireSessionEvents(newSession, newAgent)

            await newSession.start({ agent: newAgent, room })

            // Sync state
            agentState = 'listening'
            sendToFrontend({ type: 'agent_state', state: 'listening' })

            // Resume Claude session if one was active
            if (currentLLM?.sessionId) {
              currentLLM.setContinueSession(true)
            }

            // Generate recovery script via fast brain
            const recoveredSessionId = currentLLM?.sessionId || recoverySessionId
            if (recoveredSessionId) {
              try {
                const conversationHistory = await getConversationHistory(recoveredSessionId, workingDir, 10)
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareRecoveryScript(historyForScript)
                queueVoiceInjection(getScriptInjection(script))
                console.log('📋 Injected recovery script into recovered session')
              } catch (err) {
                console.log('⚠️ Failed to generate recovery script:', err)
                queueVoiceInjection(getNotificationInjection('Voice session was briefly interrupted but I\'m back. What were we working on?'))
              }
            } else {
              queueVoiceInjection(getNotificationInjection('Voice session was briefly interrupted but I\'m back. What were we working on?'))
            }

            console.log('✅ Auto-recovery complete')
          } catch (err) {
            console.error('❌ Auto-recovery failed:', err)
            sendToFrontend({ type: 'agent_state', state: 'error' })
          }
        }
      })
    }

    // Wire events on the initial session
    wireSessionEvents(session, agent)

    // Start voice session
    console.log('🎬 Starting voice session...')

    try {
      await session.start({ agent, room })
      console.log('✅ Voice session started!')
      console.log('🎤 Ready - speak to begin!\n')

      // Workspace is created later in the session_id event handler (when SDK assigns real ID)

      // Send ready signal with persistent retry
      console.log('💓 Sending agent_ready signal...')
      let readySent = false
      const provider = sessionVoiceMode === 'realtime' ? realtimeConfig.provider : 'claude'

      // Fetch full session list for startup session browser (all Claude projects)
      const allSessions = await listAllClaudeSessions(50)
      const recentSessionId = allSessions.length > 0 ? allSessions[0].sessionId : null
      const hasRecentSession = allSessions.length > 0

      // Prepare sessions for frontend (up to 50)
      const sessionsForFrontend = allSessions.slice(0, 50).map(s => ({
        sessionId: s.sessionId,
        projectSlug: s.projectSlug,
        projectPath: s.projectPath,
        cwd: s.cwd,
        timestamp: s.timestamp.toISOString(),
        lastMessage: s.lastMessage,
        messageCount: s.messageCount,
        fileSize: s.fileSize,
      }))

      const sendReady = async () => {
        if (readySent) return
        await sendToFrontend({
          type: 'agent_ready',
          provider,
          voiceMode: sessionVoiceMode,
          hasRecentSession,
          recentSessionId,
          sessions: sessionsForFrontend,
          preSelectedSessionId,
          mcpServers: getMcpServerStatusList(config),
          enabledMcpServers: enabledMcpNames,
          workingDirectory: workingDir,
          skills: loadSkillsList(sessionBaseDir),
        })
      }
      const readyInterval = setInterval(sendReady, 2000)
      await sendReady()
      setTimeout(() => {
        clearInterval(readyInterval)
        console.log('✅ agent_ready retries complete')
      }, 20000)

      // Stop agent_ready retries on user speech
      session.on('input_speech_started' as any, () => {
        readySent = true
        clearInterval(readyInterval)
      })

      // Greet user via TTS (delayed if resume prompt will be shown)
      // For realtime mode: use generateReply() since there's no standalone TTS
      // For direct mode: use say() which goes through the configured TTS
      const greetViaVoice = async (text: string) => {
        if (sessionVoiceMode === 'realtime') {
          // Use instructions (not userInput) to avoid system text appearing as user transcript
          await session.generateReply({ instructions: getScriptInjection(text) })
        } else {
          await (session as any).say(text)
        }
      }

      if (preSelectedSessionId && sessionExists(preSelectedSessionId, workingDir)) {
        // User pre-selected a session from the session browser — auto-resume immediately
        console.log(`📂 Auto-resuming pre-selected session: ${preSelectedSessionId}`)
        if (currentLLM) {
          currentLLM.setResumeSessionId(preSelectedSessionId)
          console.log(`🔄 Session resume configured: ${preSelectedSessionId}`)

          // Fetch context and greet with it
          const summary = await getSessionSummary(preSelectedSessionId, workingDir)
          const conversationHistory = await getConversationHistory(preSelectedSessionId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: preSelectedSessionId,
            success: true,
          })

          // Send existing workspace artifacts to frontend (session-scoped)
          const preArtifacts = listWorkspaceArtifacts(workingDir, preSelectedSessionId!)
          if (preArtifacts.length > 0) {
            console.log(`📁 Sending ${preArtifacts.length} workspace artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId: preSelectedSessionId,
              artifacts: preArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // Generate briefing script via fast brain
          if (summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (sessionVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareBriefingScript(workingDir, preSelectedSessionId, historyForScript)
                await session.generateReply({ instructions: getScriptInjection(script) })
              } else {
                await (session as any).say("Welcome back! Ready to continue our previous conversation.")
              }
            } catch (err) {
              console.log('⚠️ Pre-selected session greeting failed:', err)
            }
          }
        }
      } else if (!preSelectedSessionId && hasRecentSession) {
        // No pre-selected session but sessions exist — defer greeting for session gate
        console.log('⏳ Deferring greeting until session gate is completed')
      } else {
        // No sessions at all (or new session chosen) — greet as new user
        try {
          console.log('👋 Sending greeting...')
          await greetViaVoice("Hey! I'm Osborn, your AI research assistant. What are you working on today?")
          console.log('✅ Greeting sent')
        } catch (err) {
          console.log('⚠️ Greeting failed:', err)
        }
      }
    } catch (err) {
      console.error('❌ Failed to start session:', err)
    }
  })

  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    console.log(`👋 User left: ${participant.identity}`)

    // Full cleanup — stop all background work to avoid accumulating API usage
    voiceQueue.length = 0
    isProcessingQueue = false
    currentSpeechHandle = null
    lastInterruption = null

    if (researchBatchTimer) { clearTimeout(researchBatchTimer); researchBatchTimer = null }
    stopProactiveLoop()
    if (activeResearch) {
      activeResearch.abortController.abort()
      activeResearch.cleanup()
      activeResearch = null
    }

    if (currentSession) {
      const sessionToClose = currentSession
      currentSession = null
      // Track async close so new connections can wait for byte stream handler to be released
      pendingSessionClose = (async () => {
        try { await sessionToClose.close() } catch {}
        try { sessionToClose.removeAllListeners() } catch {}
        pendingSessionClose = null
      })()
    }
    currentAgent = null
    // Kill the Claude SDK subprocess BEFORE dropping the reference, otherwise the
    // persistent session keeps running tools and pushing TTS into a dead session.
    killCurrentLLM('participant_disconnected')
    currentLLM = null
    clearFastBrainSession()
    clearPipelineFastBrainSession()

    console.log('⏳ Waiting for new user...\n')
  })

  room.on(RoomEvent.DataReceived, async (payload, participant, kind, topic) => {
    if (topic !== 'user-input') return

    try {
      const data = JSON.parse(new TextDecoder().decode(payload))
      console.log('📨 Data:', data.type)

      if (data.type === 'claude_auth_code' && pendingAuthSubmitCode) {
        console.log('🔑 Received auth code from frontend')
        sendToFrontend({ type: 'claude_auth_submitting', message: 'Submitting code to Claude CLI...' })
        pendingAuthSubmitCode(data.code)
      } else if (data.type === 'permission_response') {
        // Handle permission response for direct mode
        if (currentLLM && currentLLM.hasPendingPermission?.()) {
          const allow = data.response === 'allow' || data.response === 'always_allow'
          // Track always_allow paths for this session so future requests auto-approve
          if (data.response === 'always_allow' && data.filePath) {
            sessionAlwaysAllowPaths.add(String(data.filePath))
            console.log(`🔒 Always-allow added for session: ${data.filePath}`)
          }
          currentLLM.respondToPermission(allow)
          console.log(`✅ Permission: ${data.response}`)
        }
      } else if (data.type === 'user_text' && currentSession) {
        // Build message content — include attached files (URLs, text content)
        let fullContent = String(data.content || '')
        const files = data.files as Array<{ name: string; type: string; content?: string; url?: string }> | undefined
        if (files && files.length > 0) {
          for (const f of files) {
            if (f.url) {
              fullContent += `\n\n[${f.type === 'image' ? 'Image' : 'File'}: ${f.name}](${f.url})`
            } else if (f.type === 'text' && f.content) {
              fullContent += `\n\n[File: ${f.name}]\n${f.content}`
            } else if (f.type === 'image' && f.content) {
              fullContent += `\n\n[Image attached: ${f.name}]`
            }
          }
          console.log(`📝 Text + ${files.length} file(s) (${fullContent.length} chars): "${fullContent}"`)
        } else {
          console.log(`📝 Text (${fullContent.length} chars): "${fullContent}"`)
        }
        // Skip interrupt for Gemini — disrupts state machine (hangs in speaking state)
        if (currentProvider !== 'gemini') {
          currentSession.interrupt()
        }
        await currentSession.generateReply({ userInput: fullContent })
      }
      // ============================================================
      // SESSION MANAGEMENT HANDLERS
      // ============================================================
      else if (data.type === 'list_sessions') {
        // List available sessions across all Claude projects
        console.log('📋 Listing available sessions (all projects)...')
        try {
          const sessions = await listAllClaudeSessions(100)
          await sendToFrontend({
            type: 'sessions_list',
            sessions: sessions.map(s => ({
              sessionId: s.sessionId,
              projectSlug: s.projectSlug,
              projectPath: s.projectPath,
              cwd: s.cwd,
              timestamp: s.timestamp.toISOString(),
              lastMessage: s.lastMessage,
              messageCount: s.messageCount,
              fileSize: s.fileSize,
            })),
            count: sessions.length,
          })
        } catch (err) {
          console.error('Failed to list sessions:', err)
          await sendToFrontend({
            type: 'sessions_list',
            sessions: [],
            count: 0,
            error: 'Failed to list sessions',
          })
        }
      }
      else if (data.type === 'resume_session' && currentLLM) {
        // Lightweight: set resume ID and send artifacts to frontend only
        // Context injection (generateReply) happens in session_selected handler
        // to avoid double generateReply calls that cause timeouts
        const sessionId = data.sessionId as string
        if (sessionId && sessionExists(sessionId, workingDir)) {
          currentLLM.setResumeSessionId(sessionId)
          currentResumeSessionId = sessionId
          console.log(`🔄 Will resume session: ${sessionId}`)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const artifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (artifacts.length > 0) {
            console.log(`📁 Sending ${artifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: artifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }
        } else {
          // Try to find the session in any slug directory
          let found = false
          const projectsDir = join(homedir(), '.claude', 'projects')

          if (existsSync(projectsDir)) {
            const slugDirs = readdirSync(projectsDir)
            for (const slug of slugDirs) {
              const candidate = join(projectsDir, slug, `${sessionId}.jsonl`)
              if (existsSync(candidate)) {
                // Recover the original path from the slug
                const recoveredPath = slug.replace(/^-/, '/').replace(/--/g, '/.').replace(/-/g, '/')
                if (recoveredPath && recoveredPath !== '/') {
                  mkdirSync(recoveredPath, { recursive: true })
                  workingDir = recoveredPath
                  currentLLM.setWorkingDirectory(recoveredPath)
                  console.log(`🔄 Found session in slug ${slug}, using path: ${recoveredPath}`)
                  found = true

                  // Proceed with the same success path
                  currentLLM.setResumeSessionId(sessionId)
                  currentResumeSessionId = sessionId
                  console.log(`🔄 Will resume session: ${sessionId}`)

                  await sendToFrontend({
                    type: 'session_resume_set',
                    sessionId,
                    success: true,
                  })

                  const artifacts = listWorkspaceArtifacts(workingDir, sessionId)
                  if (artifacts.length > 0) {
                    console.log(`📁 Sending ${artifacts.length} session artifacts to frontend`)
                    await sendToFrontend({
                      type: 'session_artifacts',
                      sessionId,
                      artifacts: artifacts.map(a => ({
                        filePath: a.filePath,
                        fileName: a.fileName,
                        type: a.type,
                        updatedAt: a.updatedAt,
                      }))
                    })
                  }
                  break
                }
              }
            }
          }

          if (!found) {
            console.error(`❌ Session not found: ${sessionId}`)
            await sendToFrontend({
              type: 'session_resume_set',
              sessionId,
              success: false,
              error: 'Session not found',
            })
          }
        }
      }
      else if (data.type === 'continue_session' && currentLLM) {
        const recentId = await getMostRecentSessionId(workingDir)
        if (recentId) {
          currentLLM.setResumeSessionId(recentId)
          currentResumeSessionId = recentId
          console.log(`🔄 Continuing most recent session: ${recentId}`)

          const summary = await getSessionSummary(recentId, workingDir)
          const conversationHistory = await getConversationHistory(recentId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: recentId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const artifacts = listWorkspaceArtifacts(workingDir, recentId)
          if (artifacts.length > 0) {
            console.log(`📁 Sending ${artifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId: recentId,
              artifacts: artifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            console.log('📋 Injecting session context into voice agent...')
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const script = await prepareBriefingScript(workingDir, recentId, historyForScript)
                await currentSession.generateReply({ instructions: getScriptInjection(script) })
              } else {
                await (currentSession as any).say("Continuing where we left off.")
              }
            } catch (err) {
              console.log('⚠️ Context injection failed:', err)
            }
          }
        } else {
          console.log('📋 No previous sessions found - starting fresh')
          await sendToFrontend({
            type: 'session_resume_set',
            sessionId: null,
            success: false,
            error: 'No previous sessions found',
          })
        }
      }
      else if (data.type === 'switch_session' && currentLLM) {
        // Switch to a different session mid-conversation
        const sessionId = data.sessionId as string

        if (sessionId && sessionExists(sessionId, workingDir)) {
          // Step 1: Get FULL context summary with conversation history
          const summary = await getSessionSummary(sessionId, workingDir)
          const conversationHistory = await getConversationHistory(sessionId, workingDir, 30)

          // Step 2: Reset LLM state and configure for new session
          currentLLM.resetForSessionSwitch()
          currentLLM.setResumeSessionId(sessionId)
          currentResumeSessionId = sessionId
          clearFastBrainSession()
    clearPipelineFastBrainSession()
          console.log(`🔄 Switched to session: ${sessionId}`)

          // Step 3: Send full context to frontend (including conversation history)
          await sendToFrontend({
            type: 'session_switched',
            sessionId,
            success: true,
            summary,
            conversationHistory,
          })

          // Step 3.5: Send existing session artifacts to frontend (session-scoped)
          const switchArtifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (switchArtifacts.length > 0) {
            console.log(`📁 Sending ${switchArtifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: switchArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // Step 4: Voice agent acknowledges context via fast brain
          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const briefingScript = await prepareBriefingScript(workingDir, sessionId, historyForScript, 'switch')
                queueVoiceInjection(getScriptInjection(briefingScript))
              } else {
                const acknowledgment = summary.lastMessages.length > 0
                  ? `I've switched to your previous session. You were working on: ${summary.lastMessages[summary.lastMessages.length - 1]?.substring(0, 100)}`
                  : `Switched to previous session with ${summary.messageCount} messages. What would you like to continue with?`
                await (currentSession as any).say(acknowledgment)
              }
            } catch (err) {
              console.log('⚠️ Switch acknowledgment failed:', err)
            }
          }
        } else {
          await sendToFrontend({
            type: 'session_switched',
            sessionId,
            success: false,
            error: 'Session not found',
          })
        }
      }
      else if (data.type === 'get_current_session' && currentLLM) {
        // Get current session ID
        await sendToFrontend({
          type: 'current_session',
          sessionId: currentLLM.sessionId,
          isResumingSession: currentLLM.isResumingSession,
        })
      }
      else if (data.type === 'get_session_artifacts') {
        const sessionId = data.sessionId as string
        if (sessionId) {
          const artifacts = listWorkspaceArtifacts(workingDir, sessionId)
          console.log(`📁 Sending ${artifacts.length} session artifacts for ${sessionId.substring(0, 8)}`)
          await sendToFrontend({
            type: 'session_artifacts',
            sessionId,
            artifacts: artifacts.map(a => ({
              filePath: a.filePath,
              fileName: a.fileName,
              type: a.type,
              updatedAt: a.updatedAt,
            }))
          })
        }
      }
      // ============================================================
      // SESSION GATE HANDLER (initial session selection before voice)
      // ============================================================
      else if (data.type === 'get_plan_file') {
        const filePath = data.filePath as string
        if (filePath && filePath.includes('.claude/plans/')) {
          try {
            const fs = await import('fs')
            const content = fs.readFileSync(filePath, 'utf-8')
            await sendToFrontend({ type: 'plan_file_content', filePath, content, fileName: filePath.split('/').pop() })
          } catch (err) {
            await sendToFrontend({ type: 'plan_file_content', filePath, content: '', error: (err as Error).message })
          }
        }
      }
      else if (data.type === 'get_research_artifact') {
        const filePath = data.filePath as string
        if (filePath && (filePath.includes('/osb/') || filePath.includes('.osborn/sessions/') || filePath.includes('.osborn/research/'))) {
          try {
            const fs = await import('fs')
            const path = await import('path')
            const fileName = filePath.split('/').pop() || ''
            const ext = fileName.split('.').pop()?.toLowerCase() || ''
            const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)
            const mimeByExt: Record<string, string> = {
              png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
              gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
              html: 'text/html', md: 'text/markdown', txt: 'text/plain',
              json: 'application/json',
            }
            const mimeType = mimeByExt[ext] || 'application/octet-stream'

            // Strategy: upload the file to Supabase Storage via the frontend's
            // /api/upload route and send back just the URL. This mirrors the
            // existing frontend→agent attachment flow (where the browser uploads
            // user attachments to Supabase and passes URLs to the agent). For
            // the reverse direction we do the same: URLs are ~100 bytes, so
            // the LiveKit data channel stays healthy regardless of file size.
            //
            // Fallback to inline send if OSBORN_FRONTEND_URL isn't configured
            // OR the upload fails — with a small size cap so we don't kill the
            // publisher PC with a 480KB payload (see earlier career-ops bug).
            const FRONTEND_URL = process.env.OSBORN_FRONTEND_URL || process.env.NEXT_PUBLIC_FRONTEND_URL || ''
            const MAX_INLINE_BYTES = 30_000 // fallback-only cap

            let uploadedUrl: string | null = null
            if (FRONTEND_URL) {
              try {
                const buf = fs.readFileSync(filePath)
                const form = new FormData()
                form.append('file', new Blob([buf as any], { type: mimeType }), fileName)
                form.append('folder', 'artifacts')
                // Pass userId + sessionId so /api/upload can place the file
                // under `{userId}/{sessionId}/...` in Supabase Storage for
                // easy ownership queries and future RLS policies. Both are
                // optional — route falls back to `artifacts/...` if missing.
                if (currentUserId) form.append('userId', currentUserId)
                // Prefer the live resume session id (updated by session
                // switches), fall back to whatever SDK session id the LLM
                // reports, fall back to empty.
                const uploadSessionId = currentResumeSessionId
                  || (currentLLM as any)?.sessionId
                  || ''
                if (uploadSessionId) form.append('sessionId', uploadSessionId)
                const r = await fetch(`${FRONTEND_URL.replace(/\/$/, '')}/api/upload`, {
                  method: 'POST', body: form,
                  signal: AbortSignal.timeout(15_000),
                })
                if (r.ok) {
                  const j = await r.json() as { success?: boolean; url?: string; error?: string }
                  if (j.success && j.url) {
                    uploadedUrl = j.url
                    console.log(`☁️ Uploaded artifact to Supabase: ${fileName} (${(buf.length / 1024).toFixed(0)}KB) → ${j.url.substring(0, 80)}...`)
                  } else {
                    console.warn(`⚠️ Upload failed for ${fileName}: ${j.error || 'unknown'}`)
                  }
                } else {
                  console.warn(`⚠️ Upload HTTP ${r.status} for ${fileName}`)
                }
              } catch (err) {
                console.warn(`⚠️ Upload threw for ${fileName}:`, (err as Error).message)
              }
            }

            if (uploadedUrl) {
              // Success path — send URL, no inline content.
              await sendToFrontend({
                type: 'research_artifact_content',
                filePath, fileName, url: uploadedUrl,
                isImage, mimeType,
              })
            } else if (isImage) {
              // Fallback: inline image (with size cap)
              const stats = fs.statSync(filePath)
              const base64Size = Math.ceil(stats.size * 4 / 3)
              if (base64Size > MAX_INLINE_BYTES) {
                console.log(`⚠️ Artifact too large for inline fallback: ${fileName} (${(base64Size / 1024).toFixed(0)}KB base64) — sending truncation notice`)
                await sendToFrontend({ type: 'research_artifact_content', filePath, content: '', fileName, isImage: false, truncated: true, originalSize: stats.size })
              } else {
                const base64 = fs.readFileSync(filePath, 'base64')
                await sendToFrontend({ type: 'research_artifact_content', filePath, content: base64, fileName, isImage: true, mimeType })
              }
            } else {
              // Fallback: inline text (with size cap)
              const content = fs.readFileSync(filePath, 'utf-8')
              if (Buffer.byteLength(content, 'utf-8') > MAX_INLINE_BYTES) {
                const truncated = content.substring(0, 5_000)
                console.log(`⚠️ Artifact too large for inline fallback: ${fileName} (${(Buffer.byteLength(content, 'utf-8') / 1024).toFixed(0)}KB) — sending truncated preview`)
                await sendToFrontend({ type: 'research_artifact_content', filePath, content: truncated, fileName, isImage: false, truncated: true, originalSize: Buffer.byteLength(content, 'utf-8') })
              } else {
                await sendToFrontend({ type: 'research_artifact_content', filePath, content, fileName, isImage: false })
              }
            }
          } catch (err) {
            await sendToFrontend({ type: 'research_artifact_content', filePath, content: '', error: (err as Error).message })
          }
        }
      }
      // ============================================================
      // MCP SERVER TOGGLE HANDLERS
      // ============================================================
      else if (data.type === 'mcp_toggle' && currentLLM) {
        const serverKey = data.serverKey as string
        const enabled = data.enabled as boolean
        console.log(`🔌 MCP toggle: ${serverKey} → ${enabled ? 'ON' : 'OFF'}`)

        if (enabled) {
          try {
            // Check if this is a Smithery HTTP server — use proxy to bypass SDK bug
            const catalogEntry = MCP_CATALOG.find(e => e.serverKey === serverKey)
            const isSmitheryServer = catalogEntry?.url && isSmitheryUrl(catalogEntry.url)

            if (isSmitheryServer && catalogEntry?.url) {
              // Smithery cloud server: use in-process proxy (bypasses SDK HTTP bug #18296)
              const parsed = parseSmitheryUrl(catalogEntry.url)
              if (parsed) {
                const proxyConfig = await createSmitheryProxy({
                  name: serverKey,
                  namespace: parsed.namespace,
                  connectionId: parsed.connectionId,
                })
                currentLLM.enableMcpServer(serverKey, proxyConfig)
                await announceViaVoice(`${serverKey} tools enabled.`)
              } else {
                throw new Error(`Could not parse Smithery URL: ${catalogEntry.url}`)
              }
            } else {
              // Non-Smithery server: use standard config (stdio or direct http)
              const serverConfigs = buildMcpServersForKeys(config, [serverKey])
              const serverConfig = serverConfigs[serverKey]
              if (serverConfig) {
                currentLLM.enableMcpServer(serverKey, serverConfig)
                await announceViaVoice(`${serverKey} tools enabled.`)
              } else {
                throw new Error('Server configuration not found')
              }
            }
          } catch (err) {
            const errorMsg = err instanceof SmitheryAuthorizationError
              ? `OAuth required: ${err.authorizationUrl}`
              : (err as Error).message
            console.error(`❌ MCP toggle failed for ${serverKey}: ${errorMsg}`)
            await sendToFrontend({
              type: 'mcp_toggle_result',
              serverKey,
              success: false,
              error: errorMsg,
            })
          }
        } else {
          await destroySmitheryProxy(serverKey) // Clean up proxy if exists
          currentLLM.disableMcpServer(serverKey)
          await announceViaVoice(`${serverKey} tools disabled.`)
        }

        // Send updated status back
        await sendToFrontend({
          type: 'mcp_toggle_result',
          serverKey,
          enabled,
          success: true,
          mcpServers: getMcpServerStatusList(config),
          enabledKeys: currentLLM.getEnabledMcpServerKeys(),
        })
      }
      else if (data.type === 'get_mcp_status') {
        // Frontend requesting current MCP status
        const statusList = getMcpServerStatusList(config)
        const enabledKeys = currentLLM?.getEnabledMcpServerKeys() || []
        // Merge runtime enabled state into status list
        const mergedStatus = statusList.map(s => ({
          ...s,
          enabled: enabledKeys.includes(s.serverKey),
        }))
        await sendToFrontend({
          type: 'mcp_status',
          mcpServers: mergedStatus,
          enabledKeys,
        })
      }
      else if (data.type === 'get_skills') {
        await sendToFrontend({
          type: 'skills_status',
          skills: loadSkillsList(sessionBaseDir),
        })
      }
      else if (data.type === 'skill_add') {
        const skillName = (data.name as string || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        const skillContent = (data.content as string || '').trim()
        if (!skillName || !skillContent) {
          await sendToFrontend({ type: 'skill_add_result', success: false, error: 'Name and content are required' })
        } else {
          try {
            const skillDir = join(sessionBaseDir, '.claude', 'skills', skillName)
            mkdirSync(skillDir, { recursive: true })
            writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')
            console.log(`📚 Skill added: ${skillName}`)
            const skills = loadSkillsList(sessionBaseDir)
            await sendToFrontend({ type: 'skill_add_result', success: true, skills })
          } catch (err) {
            console.error('❌ Failed to add skill:', err)
            await sendToFrontend({ type: 'skill_add_result', success: false, error: String(err) })
          }
        }
      }
      else if (data.type === 'join_meeting') {
        const meetingUrl = data.url as string
        if (meetingUrl) {
          const recallJoin = getRecallClient()
          if (!recallJoin) {
            await sendToFrontend({ type: 'meeting_error', message: 'Recall.ai not configured — set RECALL_API_KEY in .env' })
          } else {
            try {
              const webhookBase = (data.webhookBase as string) ||
                (process.env.FLY_APP_NAME
                  ? `https://${process.env.FLY_APP_NAME}.fly.dev`
                  : `http://localhost:${apiPort}`)
              await sendToFrontend({ type: 'meeting_joining', message: 'Osborn is joining your meeting...' })
              const botId = await recallJoin.joinMeeting(meetingUrl, webhookBase)
              const sessionId = currentLLM?.sessionId || currentResumeSessionId || 'default'
              recallJoin.registerBot(botId, sessionId)
              await sendToFrontend({ type: 'meeting_joined', botId, message: 'Osborn has joined the meeting' })
            } catch (err: any) {
              console.error('❌ Recall.ai join error:', err)
              await sendToFrontend({ type: 'meeting_error', message: err.message })
            }
          }
        }
      }
      else if (data.type === 'leave_meeting') {
        const botId = data.botId as string
        const recallLeave = getRecallClient()
        if (recallLeave && botId) {
          try {
            await recallLeave.leaveMeeting(botId)
            await sendToFrontend({ type: 'meeting_left', botId })
          } catch (err: any) {
            console.error('❌ Recall.ai leave error:', err)
            await sendToFrontend({ type: 'meeting_error', message: err.message })
          }
        }
      }
      else if (data.type === 'session_selected') {
        const sessionId = data.sessionId as string | null
        console.log(`🚪 Session gate completed: ${sessionId ? `resume ${sessionId}` : 'fresh start'}`)

        if (sessionId && currentLLM && sessionExists(sessionId, workingDir)) {
          // Resume the selected session
          currentLLM.setResumeSessionId(sessionId)
          currentResumeSessionId = sessionId
          console.log(`🔄 Resuming session: ${sessionId}`)

          // Fetch context and greet with it
          const summary = await getSessionSummary(sessionId, workingDir)
          const conversationHistory = await getConversationHistory(sessionId, workingDir, 30)

          await sendToFrontend({
            type: 'session_resume_set',
            sessionId,
            success: true,
          })

          // Send existing session artifacts to frontend (session-scoped)
          const gateArtifacts = listWorkspaceArtifacts(workingDir, sessionId)
          if (gateArtifacts.length > 0) {
            console.log(`📁 Sending ${gateArtifacts.length} session artifacts to frontend`)
            await sendToFrontend({
              type: 'session_artifacts',
              sessionId,
              artifacts: gateArtifacts.map(a => ({
                filePath: a.filePath,
                fileName: a.fileName,
                type: a.type,
                updatedAt: a.updatedAt,
              }))
            })
          }

          // Load full session history and greet with context via fast brain
          if (currentSession && summary) {
            loadSessionHistoryIntoChatCtx(currentAgent, conversationHistory, currentProvider)
            try {
              if (currentVoiceMode === 'realtime') {
                const historyForScript = conversationHistory.map(e => ({ role: e.role, text: e.content }))
                const briefingScript = await prepareBriefingScript(workingDir, sessionId, historyForScript, 'resume')
                queueVoiceInjection(getScriptInjection(briefingScript))
              } else {
                await (currentSession as any).say("Welcome back! Ready to continue our previous conversation.")
              }
            } catch (err) {
              console.log('⚠️ Session gate greeting failed:', err)
            }
          }
        } else {
          // Fresh start - greet via voice queue (not userInput, which creates a user transcript)
          currentResumeSessionId = undefined
          console.log('🆕 Starting fresh session')
          if (currentSession) {
            try {
              if (currentVoiceMode === 'realtime') {
                queueVoiceInjection(getScriptInjection("Hey! I'm Osborn, your AI research assistant. What are you working on today?"))
              } else {
                await (currentSession as any).say("Hey! I'm Osborn. What are you working on?")
              }
            } catch (err) {
              console.log('⚠️ Fresh session greeting failed:', err)
            }
          }
        }
      }
    } catch {}
  })

  // ============================================================
  // Connect to Room
  // ============================================================

  try {
    await room.connect(livekitUrl, jwt, {
      autoSubscribe: true,
      dynacast: true,
    })

    localParticipant = room.localParticipant
    console.log('✅ Connected to room:', roomName)

    console.log('\n⏳ Waiting for user to connect...')
    console.log(`   Room: ${roomCode}\n`)

    // Keep process alive
    await new Promise(() => {})

  } catch (err) {
    console.error('❌ Failed to connect:', err)
    process.exit(1)
  }
}

// Run
main().catch(console.error)
