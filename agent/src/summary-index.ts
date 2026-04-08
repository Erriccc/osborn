/**
 * summary-index.ts — Builds a compact searchable summary of Claude JSONL sessions
 *
 * Instead of ripgrepping 80MB raw JSONL, we extract one-line summaries per message
 * into a ~1MB plain text file. Ripgrep searches this in <5ms.
 *
 * Format: {lineNum}|{timestamp}|{source}|{msgType}|{summary}
 *
 * No LLM calls — pure heuristic extraction:
 *   tool_use  → tool name + key params (file path, command, query)
 *   tool_result → tool name + first 80 chars of output
 *   user → raw text (already short from voice)
 *   assistant → first 500 chars of text
 *
 * Per-session index stored at: ~/.claude/projects/{slug}/osb/{sessionId}/search-index.txt
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'fs'
import { join, basename, dirname } from 'path'
import { homedir } from 'os'
import { getSessionPaths, getSessionSubAgents, projectPathToSlug } from './session-access.js'

/**
 * Compute the osb index directory for a session.
 * Lives alongside Claude's native JSONL: ~/.claude/projects/{slug}/osb/{sessionId}/
 */
function getOsbDir(sessionId: string, workingDir: string): string {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const slug = projectPathToSlug(workingDir)
  return join(claudeDir, 'projects', slug, 'osb', sessionId)
}

// ============================================================
// TYPES
// ============================================================

export interface IndexEntry {
  lineNum: number
  byteOffset: number   // byte position in source file — enables 0.5ms targeted reads
  timestamp: string
  source: string       // 'main' or 'agent-{8chars}'
  msgType: string      // user, assistant, tool_use, tool_result, thinking
  summary: string      // max 500 chars, no newlines
}

export interface SummaryIndexState {
  indexPath: string
  metaPath: string
  main: {
    jsonlPath: string
    byteOffset: number
    lineCount: number
    indexLineCount: number
  }
  subAgents: Map<string, {
    jsonlPath: string
    byteOffset: number
    lineCount: number
    indexLineCount: number
  }>
  toolUseIdMap: Map<string, string>  // tool_use_id → tool_name (last 100)
}

export interface SummaryIndexMeta {
  version: 1
  sessionId: string
  createdAt: string
  updatedAt: string
  main: {
    jsonlPath: string
    byteOffset: number
    lineCount: number
    indexLineCount: number
  }
  subAgents: Record<string, {
    jsonlPath: string
    byteOffset: number
    lineCount: number
    indexLineCount: number
  }>
  toolUseIdMap: Record<string, string>
}

export interface IndexWatcher {
  stop(): void
  state: SummaryIndexState
}

// ============================================================
// SUMMARY EXTRACTION (pure heuristic — no LLM)
// ============================================================

function extractSummary(raw: any, lineNum: number, byteOffset: number, source: string): IndexEntry | null {
  try {
    // Skip non-indexable types
    if (raw.isMeta) return null
    const type = raw.type as string
    if (!type) return null
    if (type === 'queue-operation' || type === 'file-history-snapshot' || type === 'system') return null

    const ts = raw.timestamp ? new Date(raw.timestamp).toISOString().substring(0, 19) : ''

    // ── user message (regular text) ──
    if (type === 'user') {
      const content = raw.message?.content
      if (!Array.isArray(content)) return null

      // tool_result (user-type wrapper)
      if (content[0]?.type === 'tool_result') {
        const tr = content[0]
        const resultText = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content)
            ? tr.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            : ''
        // Resolve tool name from toolUseResult if available
        const toolName = raw.toolUseResult?.name || ''
        const summary = toolName
          ? `${toolName}: ${clean(resultText, 400)}`
          : `tool_result: ${clean(resultText, 400)}`
        return { lineNum, byteOffset, timestamp: ts, source, msgType: 'tool_result', summary }
      }

      // Regular user text
      const texts: string[] = []
      for (const block of content) {
        if (block?.type === 'text' && block.text) texts.push(block.text)
      }
      if (texts.length === 0) return null
      return { lineNum, byteOffset, timestamp: ts, source, msgType: 'user', summary: clean(texts.join(' '), 500) }
    }

    // ── assistant message ──
    if (type === 'assistant') {
      const content = raw.message?.content
      if (!Array.isArray(content)) return null

      const entries: IndexEntry[] = []

      for (const block of content) {
        if (block?.type === 'text' && block.text?.trim()) {
          entries.push({ lineNum, byteOffset, timestamp: ts, source, msgType: 'assistant', summary: clean(block.text, 500) })
        }
        if (block?.type === 'thinking' && block.thinking?.trim()) {
          entries.push({ lineNum, byteOffset, timestamp: ts, source, msgType: 'thinking', summary: clean(block.thinking, 500) })
        }
        if (block?.type === 'tool_use') {
          entries.push({ lineNum, byteOffset, timestamp: ts, source, msgType: 'tool_use', summary: summarizeTool(block.name, block.input) })
        }
      }

      // Return first entry (caller handles multi-entry via extractAllSummaries)
      return entries[0] || null
    }

    // ── progress (skip) ──
    if (type === 'progress') return null

    return null
  } catch {
    return null
  }
}

/**
 * Extract ALL entries from a single JSONL line (assistant messages can have
 * text + thinking + multiple tool_use blocks).
 */
function extractAllSummaries(raw: any, lineNum: number, byteOffset: number, source: string): IndexEntry[] {
  try {
    if (raw.isMeta) return []
    const type = raw.type as string
    if (!type || type === 'queue-operation' || type === 'file-history-snapshot' || type === 'system' || type === 'progress') return []

    const ts = raw.timestamp ? new Date(raw.timestamp).toISOString().substring(0, 19) : ''

    // user message
    if (type === 'user') {
      const single = extractSummary(raw, lineNum, byteOffset, source)
      return single ? [single] : []
    }

    // assistant message — can have multiple blocks
    if (type === 'assistant') {
      const content = raw.message?.content
      if (!Array.isArray(content)) return []

      const entries: IndexEntry[] = []
      for (const block of content) {
        if (block?.type === 'text' && block.text?.trim()) {
          entries.push({ lineNum, byteOffset, timestamp: ts, source, msgType: 'assistant', summary: clean(block.text, 500) })
        }
        if (block?.type === 'thinking' && block.thinking?.trim()) {
          entries.push({ lineNum, byteOffset, timestamp: ts, source, msgType: 'thinking', summary: clean(block.thinking, 500) })
        }
        if (block?.type === 'tool_use') {
          entries.push({ lineNum, byteOffset, timestamp: ts, source, msgType: 'tool_use', summary: summarizeTool(block.name, block.input) })
        }
      }
      return entries
    }

    return []
  } catch {
    return []
  }
}

/** Summarize a tool_use block into a compact one-liner */
function summarizeTool(name: string, input: any): string {
  if (!input) return name

  switch (name) {
    case 'Read':
      return `Read path="${input.file_path || ''}"${input.offset ? ` offset=${input.offset}` : ''}`
    case 'Write':
      return `Write path="${input.file_path || ''}" ${clean(input.content || '', 100)}`
    case 'Edit':
      return `Edit path="${input.file_path || ''}" old="${clean(input.old_string || '', 60)}"`
    case 'Grep':
      return `Grep pattern="${input.pattern || ''}" path="${input.path || ''}"`
    case 'Glob':
      return `Glob pattern="${input.pattern || ''}"${input.path ? ` path="${input.path}"` : ''}`
    case 'Bash':
      return `Bash cmd="${clean(input.command || '', 200)}"`
    case 'WebSearch':
      return `WebSearch query="${input.query || ''}"`
    case 'WebFetch':
      return `WebFetch url="${input.url || ''}"`
    case 'Task':
      return `Task prompt="${clean(input.prompt || input.description || '', 200)}"${input.agentId ? ` agentId=${input.agentId}` : ''}`
    case 'TodoWrite':
      return `TodoWrite ${clean(JSON.stringify(input.todos || []), 200)}`
    default:
      return `${name} ${clean(JSON.stringify(input), 300)}`
  }
}

/** Clean text: remove newlines, cap length */
function clean(text: string, maxLen: number): string {
  return text.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, maxLen)
}

/** Format an IndexEntry as a pipe-delimited line */
function formatLine(entry: IndexEntry): string {
  return `${entry.lineNum}|${entry.byteOffset}|${entry.timestamp}|${entry.source}|${entry.msgType}|${entry.summary}`
}

// ============================================================
// BUILD INDEX (cold start / catch-up)
// ============================================================

/**
 * Build or resume a summary index for a session.
 * Reads main JSONL + all sub-agent JSONLs, extracts summaries.
 * If an existing index with metadata exists, resumes from last byte offset.
 */
export function buildSummaryIndex(
  sessionId: string,
  workingDir: string,
  _sessionBaseDir?: string,  // deprecated — kept for backward compat, ignored
  onProgress?: (msg: string) => void,
): SummaryIndexState {
  const paths = getSessionPaths(sessionId, workingDir)
  if (!paths.exists) {
    onProgress?.('No session files found')
    return emptyState(sessionId, workingDir, paths.conversation)
  }

  const workspace = getOsbDir(sessionId, workingDir)
  mkdirSync(workspace, { recursive: true })
  const indexPath = join(workspace, 'search-index.txt')
  const metaPath = join(workspace, 'search-index-meta.json')

  // Check for existing metadata (resume from last offset)
  let state = loadOrCreateState(indexPath, metaPath, paths.conversation)

  const startMs = Date.now()

  // ── Index main JSONL ──
  const mainEntries = indexFile(paths.conversation, 'main', state.main.byteOffset)
  if (mainEntries.lines.length > 0) {
    appendFileSync(indexPath, mainEntries.lines.join('\n') + '\n')
    state.main.byteOffset = mainEntries.newByteOffset
    state.main.lineCount += mainEntries.linesProcessed
    state.main.indexLineCount += mainEntries.lines.length
    // Collect tool_use_id → name mappings
    for (const [id, name] of mainEntries.toolMap) {
      state.toolUseIdMap.set(id, name)
    }
  }

  onProgress?.(`Main JSONL: ${mainEntries.lines.length} entries in ${Date.now() - startMs}ms`)

  // ── Discover and index sub-agents (both paths: subagents/ dir + project-level agent-*.jsonl) ──
  const subAgentMs = Date.now()
  let subAgentEntries = 0

  // Path 1: Session subdirectory subagents/ (discovered by getSessionPaths)
  for (const agentFile of paths.subagents) {
    const fileName = basename(agentFile, '.jsonl')
    const agentKey = fileName.replace('agent-', '').substring(0, 12)
    const sourceTag = `agent-${agentKey.substring(0, 8)}`

    const existing = state.subAgents.get(agentKey)
    const offset = existing?.byteOffset || 0

    const result = indexFile(agentFile, sourceTag, offset)
    if (result.lines.length > 0) {
      appendFileSync(indexPath, result.lines.join('\n') + '\n')
      subAgentEntries += result.lines.length

      state.subAgents.set(agentKey, {
        jsonlPath: agentFile,
        byteOffset: result.newByteOffset,
        lineCount: (existing?.lineCount || 0) + result.linesProcessed,
        indexLineCount: (existing?.indexLineCount || 0) + result.lines.length,
      })
    }
  }

  // Path 2: Project-level agent-*.jsonl (discovered by getSessionSubAgents)
  const agents = getSessionSubAgents(sessionId, workingDir)
  for (const agent of agents) {
    if (!agent.agentFileExists) continue
    const agentKey = agent.agentId.substring(0, 12)
    if (state.subAgents.has(agentKey)) continue // already indexed from Path 1
    const sourceTag = `agent-${agent.agentId.substring(0, 8)}`

    const existing = state.subAgents.get(agentKey)
    const offset = existing?.byteOffset || 0

    const result = indexFile(agent.agentFile, sourceTag, offset)
    if (result.lines.length > 0) {
      appendFileSync(indexPath, result.lines.join('\n') + '\n')
      subAgentEntries += result.lines.length

      state.subAgents.set(agentKey, {
        jsonlPath: agent.agentFile,
        byteOffset: result.newByteOffset,
        lineCount: (existing?.lineCount || 0) + result.linesProcessed,
        indexLineCount: (existing?.indexLineCount || 0) + result.lines.length,
      })
    }
  }

  onProgress?.(`Sub-agents: ${agents.length} found, ${subAgentEntries} entries in ${Date.now() - subAgentMs}ms`)

  // Trim toolUseIdMap to last 100
  if (state.toolUseIdMap.size > 100) {
    const entries = [...state.toolUseIdMap.entries()]
    state.toolUseIdMap = new Map(entries.slice(-100))
  }

  // Save metadata
  saveMeta(state, sessionId, metaPath)

  const totalMs = Date.now() - startMs
  const indexSize = existsSync(indexPath) ? statSync(indexPath).size : 0
  onProgress?.(`Index complete: ${state.main.indexLineCount + subAgentEntries} total entries, ${(indexSize / 1024).toFixed(0)}KB, ${totalMs}ms`)

  return state
}

/** Index a single JSONL file from a byte offset. Returns formatted lines + new offset. */
function indexFile(
  filePath: string,
  source: string,
  fromByteOffset: number,
): { lines: string[]; linesProcessed: number; newByteOffset: number; toolMap: Map<string, string> } {
  if (!existsSync(filePath)) {
    return { lines: [], linesProcessed: 0, newByteOffset: fromByteOffset, toolMap: new Map() }
  }

  const fileSize = statSync(filePath).size
  if (fromByteOffset >= fileSize) {
    return { lines: [], linesProcessed: 0, newByteOffset: fromByteOffset, toolMap: new Map() }
  }

  // Read from offset
  const buf = Buffer.alloc(fileSize - fromByteOffset)
  const fd = openSync(filePath, 'r')
  readSync(fd, buf, 0, buf.length, fromByteOffset)
  closeSync(fd)

  const text = buf.toString('utf-8')
  const rawLines = text.split('\n')
  const outputLines: string[] = []
  const toolMap = new Map<string, string>()
  let lineNum = fromByteOffset === 0 ? 1 : countLines(filePath, fromByteOffset) + 1
  let linesProcessed = 0
  let currentByteOffset = fromByteOffset  // track byte position — zero overhead

  for (const rawLine of rawLines) {
    const lineByteOffset = currentByteOffset
    currentByteOffset += Buffer.byteLength(rawLine, 'utf-8') + 1  // +1 for \n

    if (!rawLine.trim()) { lineNum++; continue }
    linesProcessed++
    try {
      const obj = JSON.parse(rawLine)

      // Track tool_use_id → tool_name for resolving tool_result entries
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === 'tool_use' && block.id && block.name) {
            toolMap.set(block.id, block.name)
          }
        }
      }

      // Extract all summaries — byteOffset enables instant targeted reads later
      const entries = extractAllSummaries(obj, lineNum, lineByteOffset, source)
      for (const entry of entries) {
        outputLines.push(formatLine(entry))
      }
    } catch {
      // Skip unparseable lines
    }
    lineNum++
  }

  return {
    lines: outputLines,
    linesProcessed,
    newByteOffset: fileSize,
    toolMap,
  }
}

/** Count lines in a file up to a byte offset (for line number tracking on resume) */
function countLines(filePath: string, upToBytes: number): number {
  const buf = Buffer.alloc(Math.min(upToBytes, 1024 * 1024)) // Read max 1MB for line counting
  const fd = openSync(filePath, 'r')
  const bytesRead = readSync(fd, buf, 0, buf.length, Math.max(0, upToBytes - buf.length))
  closeSync(fd)
  let count = 0
  for (let i = 0; i < bytesRead; i++) {
    if (buf[i] === 10) count++ // newline
  }
  return count
}

// ============================================================
// INCREMENTAL WATCHER
// ============================================================

/**
 * Poll-based incremental index updater (10s interval).
 * Checks main JSONL + sub-agents for new content, indexes in one batch.
 * No fs.watch — avoids race conditions with concurrent writers.
 */
export function startIndexWatcher(
  sessionId: string,
  workingDir: string,
  _sessionBaseDir: string | undefined,  // deprecated — kept for backward compat, ignored
  state: SummaryIndexState,
): IndexWatcher {
  let stopped = false

  const pollInterval = setInterval(() => {
    if (stopped) return
    try {
      let newEntries = 0

      // 1. Check main JSONL for new content
      const mainResult = indexFile(state.main.jsonlPath, 'main', state.main.byteOffset)
      if (mainResult.lines.length > 0) {
        appendFileSync(state.indexPath, mainResult.lines.join('\n') + '\n')
        state.main.byteOffset = mainResult.newByteOffset
        state.main.lineCount += mainResult.linesProcessed
        state.main.indexLineCount += mainResult.lines.length
        newEntries += mainResult.lines.length
        for (const [id, name] of mainResult.toolMap) {
          state.toolUseIdMap.set(id, name)
        }
      }

      // 2. Check for new sub-agents + update existing ones
      const paths = getSessionPaths(sessionId, workingDir)
      const allSubFiles = [...paths.subagents]
      const agents = getSessionSubAgents(sessionId, workingDir)
      for (const a of agents) {
        if (a.agentFileExists && !allSubFiles.includes(a.agentFile)) {
          allSubFiles.push(a.agentFile)
        }
      }

      for (const agentFile of allSubFiles) {
        if (!existsSync(agentFile)) continue
        const fileName = basename(agentFile, '.jsonl')
        const agentKey = fileName.replace('agent-', '').substring(0, 12)
        const sourceTag = `agent-${agentKey.substring(0, 8)}`

        const existing = state.subAgents.get(agentKey)
        const offset = existing?.byteOffset || 0

        const result = indexFile(agentFile, sourceTag, offset)
        if (result.lines.length > 0) {
          appendFileSync(state.indexPath, result.lines.join('\n') + '\n')
          newEntries += result.lines.length
          state.subAgents.set(agentKey, {
            jsonlPath: agentFile,
            byteOffset: result.newByteOffset,
            lineCount: (existing?.lineCount || 0) + result.linesProcessed,
            indexLineCount: (existing?.indexLineCount || 0) + result.lines.length,
          })
        }
      }

      if (newEntries > 0) {
        console.log(`🔍 [index] +${newEntries} entries`)
        saveMeta(state, sessionId, state.metaPath)
      }
    } catch (err: any) {
      // Suppress ENOENT — index file doesn't exist yet, normal for new/unindexed sessions
      if (err?.code !== 'ENOENT') {
        console.error('🔍 [index] Poll error:', err?.message)
      }
    }
  }, 10_000)

  return {
    stop() {
      stopped = true
      clearInterval(pollInterval)
      saveMeta(state, sessionId, state.metaPath)
    },
    state,
  }
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

function emptyState(sessionId: string, workingDir: string, mainJsonlPath: string): SummaryIndexState {
  const workspace = getOsbDir(sessionId, workingDir)
  return {
    indexPath: join(workspace, 'search-index.txt'),
    metaPath: join(workspace, 'search-index-meta.json'),
    main: { jsonlPath: mainJsonlPath, byteOffset: 0, lineCount: 0, indexLineCount: 0 },
    subAgents: new Map(),
    toolUseIdMap: new Map(),
  }
}

function loadOrCreateState(indexPath: string, metaPath: string, mainJsonlPath: string): SummaryIndexState {
  if (existsSync(metaPath)) {
    try {
      const meta: SummaryIndexMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      // Validate main file hasn't shrunk (file corruption/replacement)
      if (existsSync(meta.main.jsonlPath)) {
        const currentSize = statSync(meta.main.jsonlPath).size
        if (meta.main.byteOffset <= currentSize) {
          return {
            indexPath,
            metaPath,
            main: meta.main,
            subAgents: new Map(Object.entries(meta.subAgents || {})),
            toolUseIdMap: new Map(Object.entries(meta.toolUseIdMap || {})),
          }
        }
      }
    } catch {}
  }

  // Fresh state — will build from scratch
  // Ensure index file starts empty
  writeFileSync(indexPath, '')

  return {
    indexPath,
    metaPath,
    main: { jsonlPath: mainJsonlPath, byteOffset: 0, lineCount: 0, indexLineCount: 0 },
    subAgents: new Map(),
    toolUseIdMap: new Map(),
  }
}

function saveMeta(state: SummaryIndexState, sessionId: string, metaPath: string) {
  const meta: SummaryIndexMeta = {
    version: 1,
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    main: state.main,
    subAgents: Object.fromEntries(state.subAgents),
    toolUseIdMap: Object.fromEntries([...state.toolUseIdMap.entries()].slice(-100)),
  }
  try {
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  } catch {}
}

// ============================================================
// PUBLIC: Check if index exists for a session
// ============================================================

export function getIndexPath(sessionId: string, workingDir: string): string | null {
  const indexPath = join(getOsbDir(sessionId, workingDir), 'search-index.txt')
  return existsSync(indexPath) && statSync(indexPath).size > 0 ? indexPath : null
}

// ============================================================
// PUBLIC: Read full clean text from raw JSONL by line numbers
// ============================================================

/**
 * Given index search results (with byte offsets + source tags),
 * read FULL content from raw JSONL via targeted reads — 0.5ms per result.
 * No readFileSync of the whole file. Strips JSON noise, returns clean text.
 */
export function readFullContent(
  results: { lineNum: number; byteOffset: number; source: string }[],
  sessionId: string,
  workingDir: string,
  _sessionBaseDir?: string,  // deprecated — kept for backward compat, ignored
  maxCharsPerResult = 2000,
): string[] {
  const paths = getSessionPaths(sessionId, workingDir)
  const output: string[] = []

  // Group results by source file
  const bySource = new Map<string, { lineNum: number; byteOffset: number }[]>()
  for (const r of results) {
    if (!bySource.has(r.source)) bySource.set(r.source, [])
    bySource.get(r.source)!.push({ lineNum: r.lineNum, byteOffset: r.byteOffset })
  }

  for (const [source, refs] of bySource) {
    // Resolve source to file path
    let filePath: string
    if (source === 'main') {
      filePath = paths.conversation
    } else {
      const agentPrefix = source.replace('agent-', '')
      const subFile = paths.subagents.find(f => basename(f).includes(agentPrefix))
        || join(dirname(paths.conversation), `agent-${agentPrefix}.jsonl`)
      filePath = subFile
    }

    if (!existsSync(filePath)) continue
    const fileSize = statSync(filePath).size

    // Targeted read per result — ~0.5ms each instead of 459ms for whole file
    const fd = openSync(filePath, 'r')
    try {
      for (const ref of refs) {
        if (ref.byteOffset >= fileSize) continue

        // Read up to 100KB from the byte offset (enough for any single JSONL line)
        const readLen = Math.min(100 * 1024, fileSize - ref.byteOffset)
        const buf = Buffer.alloc(readLen)
        readSync(fd, buf, 0, readLen, ref.byteOffset)

        // Extract just the first line (one JSONL entry)
        const text = buf.toString('utf-8')
        const newlineIdx = text.indexOf('\n')
        const jsonLine = newlineIdx >= 0 ? text.substring(0, newlineIdx) : text

        try {
          const obj = JSON.parse(jsonLine)
          const cleanText = extractCleanText(obj, maxCharsPerResult)
          if (cleanText) {
            output.push(`[${source} L${ref.lineNum}] ${cleanText}`)
          }
        } catch {}
      }
    } finally {
      closeSync(fd)
    }
  }

  return output
}

/** Extract clean human-readable text from a parsed JSONL object — no JSON noise */
function extractCleanText(obj: any, maxChars: number): string {
  const parts: string[] = []

  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block?.type === 'text' && block.text) {
        parts.push(block.text)
      }
      if (block?.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
            : ''
        if (content) parts.push(content)
      }
    }
  }

  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block?.type === 'text' && block.text) parts.push(block.text)
      if (block?.type === 'thinking' && block.thinking) parts.push(`[thinking] ${block.thinking}`)
      if (block?.type === 'tool_use') {
        parts.push(summarizeTool(block.name, block.input))
      }
    }
  }

  const joined = parts.join('\n').trim()
  return joined.substring(0, maxChars)
}
