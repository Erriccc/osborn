/**
 * jsonl-search.ts — Ripgrep search and BM25 search utilities for JSONL session files
 *
 * Provides two search strategies over Claude Agent SDK session data:
 *   1. ripgrepSearch — fast regex search via rg (or grep fallback) across files
 *   2. bm25Search   — in-memory full-text search over parsed session messages
 *
 * Also provides resolveJsonlDir() for locating the JSONL project directory
 * and invalidateBM25Cache() for cache management.
 */

import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readSessionHistory } from './session-access.js'
import type { SessionMessage } from './session-access.js'

// ============================================================
// TYPES
// ============================================================

export interface RipgrepResult {
  lineNumber: number
  filePath: string
  content: string
}

export interface BM25Result {
  content: string
  score: number
  type?: string
}

// ============================================================
// BM25 CACHE
// ============================================================

let bm25Cache: { index: any; sessionId: string; builtAt: number } | null = null

// ============================================================
// INTERNAL HELPERS
// ============================================================

/** Resolve the claude config directory (same logic as session-access.ts) */
function resolveClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Convert a project path to a slug (same logic as session-access.ts) */
function projectPathToSlug(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

/** Find the rg binary — uses @vscode/ripgrep npm package (bundled binary) */
function findRgBinary(): string | null {
  try {
    // @vscode/ripgrep bundles the rg binary — this is our own dependency
    const { rgPath } = require('@vscode/ripgrep')
    if (rgPath && existsSync(rgPath)) return rgPath
  } catch {}
  return null
}

/** Validate a search pattern — reject empty and shell-injection characters */
function validatePattern(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) return false
  // Block shell-injection characters
  if (/[\$`|;&]/.test(pattern)) return false
  return true
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Search files using ripgrep (rg) with fallback to grep.
 *
 * @param searchDir - Directory to search in
 * @param pattern - Regex pattern to search for (validated for safety)
 * @param opts.maxResults - Maximum number of results (default: 100)
 * @param opts.include - Glob pattern for file inclusion (e.g., "*.jsonl")
 * @returns Array of matches with line number, file path, and content
 */
export function ripgrepSearch(
  searchDir: string,
  pattern: string,
  opts?: { maxResults?: number; include?: string; contextLines?: number; fromEnd?: boolean }
): RipgrepResult[] {
  if (!validatePattern(pattern)) return []
  if (!existsSync(searchDir)) return []

  const maxResults = opts?.maxResults ?? 100
  const fromEnd = opts?.fromEnd ?? false  // caller decides; pipeline uses true for main, false for sub-agents
  const rgBinary = findRgBinary()

  if (rgBinary) {
    if (fromEnd) {
      // Search ALL matches (no --max-count), take last N — gets most recent
      const allResults = runRipgrep(rgBinary, searchDir, pattern, 0, opts?.include, opts?.contextLines)
      return allResults.slice(-maxResults)
    }
    return runRipgrep(rgBinary, searchDir, pattern, maxResults, opts?.include, opts?.contextLines)
  }

  // Fallback to grep
  return runGrepFallback(searchDir, pattern, maxResults, opts?.include)
}

/** Run ripgrep and parse results */
function runRipgrep(
  rgPath: string,
  searchDir: string,
  pattern: string,
  maxResults: number,
  include?: string,
  contextLines?: number,
): RipgrepResult[] {
  const args = [
    '--no-heading',
    '--with-filename',
    '--line-number',
    '-i',
  ]

  // maxResults 0 = no cap (search all, caller handles slicing)
  if (maxResults > 0) {
    args.push('--max-count', String(maxResults))
  }

  // Add context lines for surrounding message context (default: 3 lines each side)
  const ctx = contextLines ?? 3
  if (ctx > 0) {
    args.push('-C', String(ctx))
  }

  if (include) {
    args.push('--glob', include)
  }

  args.push(pattern, searchDir)

  const result = spawnSync(rgPath, args, {
    maxBuffer: 2 * 1024 * 1024, // 2MB
    timeout: 5000,
    encoding: 'utf-8',
  })

  // Exit code 1 = no matches (not an error)
  if (result.status === 1) return []

  // Any other non-zero exit is an error
  if (result.status !== 0 && result.status !== null) return []

  return parseSearchOutput(result.stdout || '')
}

/** Fallback to grep if rg is not found */
function runGrepFallback(
  searchDir: string,
  pattern: string,
  maxResults: number,
  include?: string
): RipgrepResult[] {
  const args = [
    '-r',
    '-n',
    '-i',
    '-m', String(maxResults),
  ]

  if (include) {
    args.push('--include', include)
  }

  args.push(pattern, searchDir)

  const result = spawnSync('grep', args, {
    maxBuffer: 2 * 1024 * 1024, // 2MB
    timeout: 5000,
    encoding: 'utf-8',
  })

  // Exit code 1 = no matches
  if (result.status === 1) return []
  if (result.status !== 0 && result.status !== null) return []

  return parseSearchOutput(result.stdout || '')
}

/** Parse output lines in the format: filePath:lineNumber:content */
function parseSearchOutput(stdout: string): RipgrepResult[] {
  if (!stdout || !stdout.trim()) return []

  const results: RipgrepResult[] = []
  const lines = stdout.trim().split('\n')

  for (const line of lines) {
    // Format: filePath:lineNumber:content
    const match = line.match(/^(.+?):(\d+):(.*)$/)
    if (match) {
      results.push({
        filePath: match[1],
        lineNumber: parseInt(match[2], 10),
        content: match[3],
      })
    }
  }

  return results
}

/**
 * Full-text search over session messages using BM25 ranking via MiniSearch.
 *
 * Builds an in-memory index from readSessionHistory() and caches it per session.
 * The cache is invalidated when the sessionId changes or invalidateBM25Cache() is called.
 *
 * @param sessionId - The session UUID
 * @param workingDir - The project working directory
 * @param query - The search query (natural language or keywords)
 * @param opts.maxResults - Maximum number of results (default: 20)
 * @returns Ranked array of matches with content, score, and optional type
 */
export async function bm25Search(
  sessionId: string,
  workingDir: string,
  query: string,
  opts?: { maxResults?: number }
): Promise<BM25Result[]> {
  if (!query || !query.trim()) return []

  const maxResults = opts?.maxResults ?? 20

  // Rebuild index if cache is stale or for a different session
  if (!bm25Cache || bm25Cache.sessionId !== sessionId) {
    const { default: MiniSearch } = await import('minisearch')

    const miniSearch = new MiniSearch({
      fields: ['text'],
      storeFields: ['text', 'type', 'toolName', 'timestamp'],
      searchOptions: {
        fuzzy: 0.2,
        prefix: true,
        boost: { text: 2 },
      },
    })

    // Load recent session messages only — cap at 500 to keep index build fast
    // For a 4400-message session, loading all would take 10+ seconds
    const messages = readSessionHistory(sessionId, workingDir, { lastN: 500 })

    // Build documents — filter to entries with meaningful text
    const docs: Array<{
      id: number
      text: string
      type: string
      toolName?: string
      timestamp?: string
    }> = []

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const text = extractMessageText(msg)
      if (text && text.length > 10) {
        docs.push({
          id: i,
          text: text.substring(0, 2000),
          type: msg.type,
          toolName: msg.toolName,
          timestamp: msg.timestamp,
        })
      }
    }

    miniSearch.addAll(docs)

    bm25Cache = {
      index: miniSearch,
      sessionId,
      builtAt: Date.now(),
    }
  }

  // Search the index
  const results = bm25Cache.index.search(query, { limit: maxResults })

  return results.map((r: any) => ({
    content: r.text || '',
    score: r.score,
    type: r.type,
  }))
}

/** Extract searchable text from a SessionMessage */
function extractMessageText(msg: SessionMessage): string | undefined {
  switch (msg.type) {
    case 'user':
    case 'assistant':
      return msg.text
    case 'tool_use':
      // Include tool name + any associated text + stringified input
      const parts: string[] = []
      if (msg.toolName) parts.push(msg.toolName)
      if (msg.text) parts.push(msg.text)
      if (msg.toolInput) {
        try {
          parts.push(JSON.stringify(msg.toolInput))
        } catch {
          // skip
        }
      }
      return parts.join(' ') || undefined
    case 'tool_result':
      return msg.toolResultContent
    default:
      return undefined
  }
}

/**
 * Resolve the JSONL directory for a session.
 * Uses the same slug resolution as session-access.ts.
 *
 * @param sessionId - The session UUID
 * @param workingDir - The project working directory
 * @returns The directory path containing JSONL files, or null if it doesn't exist
 */
export function resolveJsonlDir(sessionId: string, workingDir: string): string | null {
  const claudeDir = resolveClaudeDir()
  const slug = projectPathToSlug(workingDir)
  const projectsDir = join(claudeDir, 'projects', slug)

  if (!existsSync(projectsDir)) return null

  return projectsDir
}

/**
 * Clear the BM25 cache. Call this when session data has changed
 * and you want the next bm25Search() call to rebuild the index.
 *
 * @param sessionId - The session ID to invalidate (currently clears any cached session)
 */
export function invalidateBM25Cache(sessionId: string): void {
  if (bm25Cache && bm25Cache.sessionId === sessionId) {
    bm25Cache = null
  }
}
