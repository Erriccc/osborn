/**
 * recall-cli.ts — `osborn-recall` — query a session's embedded store from the shell.
 *
 * A FIXED, predictable command interface over session-store.ts. Grounded agents (or a
 * pre-turn recall hook) call this instead of grepping a flat file — it returns the most
 * relevant PRIOR messages (full text) via hybrid keyword+semantic search.
 *
 * Usage:
 *   osborn-recall "<query>" [--mode hybrid|keyword|vector] [--top-k 8]
 *                           [--db <path> | --session <id> [--cwd <dir>]]
 *                           [--max-chars 1200] [--json] [--type user,assistant,...]
 *   osborn-recall --list [--cwd <dir>]      # list available session stores
 *
 * Resolution order for the store: --db → --session(+--cwd) → newest session.db under
 * the cwd's project slug.
 */

import { existsSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { openStore, recall, getStorePath, type RecallHit } from './session-store.js'
import { getEmbedder } from './embedder.js'

function projectSlug(dir: string): string {
  return dir.replace(/\//g, '-')
}

function osbRoot(cwd: string): string {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(claudeDir, 'projects', projectSlug(cwd), 'osb')
}

/** Every session.db under a project's osb dir, newest first. */
function listStores(cwd: string): { sessionId: string; path: string; mtime: number; bytes: number }[] {
  const root = osbRoot(cwd)
  if (!existsSync(root)) return []
  const out: { sessionId: string; path: string; mtime: number; bytes: number }[] = []
  for (const sid of readdirSync(root)) {
    const p = join(root, sid, 'session.db')
    if (existsSync(p)) {
      const st = statSync(p)
      out.push({ sessionId: sid, path: p, mtime: st.mtimeMs, bytes: st.size })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) opts[key] = true
      else { opts[key] = next; i++ }
    } else {
      positional.push(a)
    }
  }
  return { opts, positional }
}

function resolveDbPath(opts: Record<string, string | boolean>, cwd: string): string | null {
  if (typeof opts.db === 'string') return existsSync(opts.db) ? opts.db : null
  if (typeof opts.session === 'string') {
    const p = getStorePath(opts.session, cwd)
    return existsSync(p) ? p : null
  }
  const stores = listStores(cwd)
  return stores[0]?.path ?? null
}

function fmtHit(h: RecallHit, maxChars: number): string {
  const head = `[${h.source} L${h.lineNum} · ${h.msgType}${h.toolName ? `:${h.toolName}` : ''} · ${h.matchedBy}${h.model ? ` · ${h.model}` : ''}] ${h.ts || ''}`
  let body = h.text.replace(/\n{3,}/g, '\n\n').trim()
  if (maxChars > 0 && body.length > maxChars) body = body.slice(0, maxChars) + ' …[truncated]'
  return `${head}\n${body}`
}

export async function main(argv: string[]): Promise<number> {
  const { opts, positional } = parseArgs(argv)
  const cwd = (typeof opts.cwd === 'string' ? opts.cwd : '') || process.env.OSBORN_CWD || process.cwd()

  if (opts.list) {
    const stores = listStores(cwd)
    if (!stores.length) { console.log(`No session stores under ${osbRoot(cwd)}`); return 0 }
    for (const s of stores) {
      console.log(`${s.sessionId}  ${(s.bytes / 1024 / 1024).toFixed(2)}MB  ${new Date(s.mtime).toISOString()}`)
    }
    return 0
  }

  const query = positional.join(' ').trim()
  if (!query) {
    console.error('Usage: osborn-recall "<query>" [--mode hybrid|keyword|vector] [--top-k 8] [--db <path> | --session <id> --cwd <dir>] [--max-chars 1200] [--json]')
    return 2
  }

  const dbPath = resolveDbPath(opts, cwd)
  if (!dbPath) {
    console.error(`No session store found (looked in ${osbRoot(cwd)}). Pass --db <path> or --session <id> --cwd <dir>.`)
    return 1
  }

  const mode = (typeof opts.mode === 'string' ? opts.mode : 'hybrid') as 'hybrid' | 'keyword' | 'vector'
  const topK = typeof opts['top-k'] === 'string' ? parseInt(opts['top-k'] as string, 10) : 8
  const maxChars = typeof opts['max-chars'] === 'string' ? parseInt(opts['max-chars'] as string, 10) : 1200

  // Embedder only needed for semantic legs; keyword mode never loads the model.
  const embed = mode === 'keyword' ? null : await getEmbedder()
  if ((mode === 'vector' || mode === 'hybrid') && !embed && !opts.json) {
    console.error('(note: embedder unavailable — falling back to keyword-only)')
  }

  const db = openStore(dbPath)
  try {
    let hits = await recall(db, query, { mode, topK, embed: embed ?? undefined })
    if (typeof opts.type === 'string') {
      const types = new Set((opts.type as string).split(',').map(s => s.trim()))
      hits = hits.filter(h => types.has(h.msgType))
    }

    if (opts.json) {
      console.log(JSON.stringify({ query, mode, dbPath, count: hits.length, hits }, null, 2))
      return 0
    }

    if (!hits.length) { console.log(`No matches for "${query}" in ${dbPath}`); return 0 }
    console.log(`# recall: "${query}"  (${mode}, ${hits.length} hits)  ${dbPath}\n`)
    hits.forEach((h, i) => console.log(`── ${i + 1}/${hits.length} ──\n${fmtHit(h, maxChars)}\n`))
    return 0
  } finally {
    db.close()
  }
}

// Run when invoked directly (bin shim imports and calls main()).
main(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch(err => { console.error('osborn-recall error:', err?.message || err); process.exit(1) })
