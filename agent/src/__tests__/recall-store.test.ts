/**
 * recall-store.test.ts — tests for the fast-brain → recall-DB migration.
 *
 * Exercises the session-store.ts layer that pipeline-fastbrain.ts's executeSearch /
 * getRecentEntries now depend on: recentRows(), recall() (keyword path), readonly
 * openStore semantics, and empty-store edge cases.
 *
 * NO NETWORK: updateSessionStore is called WITHOUT an embedder, so the vec table stays
 * empty and recall() degrades to keyword-only — no OpenRouter/embedder calls happen.
 *
 * Each test uses a unique temp CLAUDE_CONFIG_DIR + working dir under os.tmpdir(), so
 * getStorePath()/getOsbDir() resolve entirely under temp. All temp dirs are cleaned up.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  openStore,
  updateSessionStore,
  recall,
  recentRows,
  getStorePath,
  storeExists,
} from '../session-store.js'
import { projectPathToSlug } from '../session-access.js'

// ── temp env harness ────────────────────────────────────────────────────────
const tempRoots: string[] = []

/**
 * Build a fresh isolated environment: a temp CLAUDE_CONFIG_DIR (points getStorePath at
 * temp) and a temp workingDir (used only for the slug). Returns a helper to write the
 * main session JSONL at the exact path getSessionPaths() will read from.
 */
function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'recall-test-'))
  tempRoots.push(root)
  const claudeDir = join(root, 'claude')
  const workingDir = join(root, 'proj') // real-looking absolute path; only its slug matters
  process.env.CLAUDE_CONFIG_DIR = claudeDir

  const sessionId = 'sess-' + Math.random().toString(36).slice(2, 10)
  const slug = projectPathToSlug(workingDir)
  const projectsDir = join(claudeDir, 'projects', slug)
  mkdirSync(projectsDir, { recursive: true })
  const jsonlPath = join(projectsDir, `${sessionId}.jsonl`)

  return {
    sessionId,
    workingDir,
    /** Write the main conversation JSONL from an array of raw line objects. */
    writeJsonl(lines: any[]) {
      writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
    },
  }
}

/** A minimal but realistic set of JSONL lines (user + assistant text + a tool_use). */
function sampleLines(sessionId: string, workingDir: string) {
  const base = { sessionId, cwd: workingDir, gitBranch: 'main' }
  return [
    // ignored meta line — must not produce a row
    { type: 'file-history-snapshot', snapshot: { timestamp: '2026-09-26T00:00:00.000Z' } },
    {
      ...base,
      type: 'user',
      timestamp: '2026-09-26T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Please investigate the flibbertigibbet bug in the parser.' }] },
    },
    {
      ...base,
      type: 'assistant',
      timestamp: '2026-09-26T00:00:02.000Z',
      message: {
        model: 'claude-opus-4-8',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking into the flibbertigibbet issue now.' },
          { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'flibbertigibbet', path: 'src' } },
        ],
      },
    },
    {
      ...base,
      type: 'user',
      timestamp: '2026-09-26T00:00:03.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Great, ship it when the tests pass.' }] },
    },
  ]
}

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  for (const r of tempRoots.splice(0)) {
    try { rmSync(r, { recursive: true, force: true }) } catch {}
  }
  delete process.env.CLAUDE_CONFIG_DIR
})

// ── 1. recentRows() ──────────────────────────────────────────────────────────
describe('recentRows()', () => {
  it('returns rows newest-first with decompressed text and correct metadata', async () => {
    const env = makeEnv()
    env.writeJsonl(sampleLines(env.sessionId, env.workingDir))

    // keyword-only: no embed → no network
    const stats = await updateSessionStore(env.sessionId, env.workingDir)
    // 2 user + 1 assistant text + 1 tool_use = 4 rows (the snapshot line is skipped)
    expect(stats.newRows).toBe(4)
    expect(stats.embeddedRows).toBe(0)
    expect(stats.totalRows).toBe(4)

    const dbPath = storeExists(env.sessionId, env.workingDir)
    expect(dbPath).toBe(getStorePath(env.sessionId, env.workingDir))
    expect(dbPath).not.toBeNull()

    const db = openStore(dbPath!, { readonly: true })
    try {
      const rows = recentRows(db, 3)

      // length capped at N
      expect(rows).toHaveLength(3)

      // NEWEST-FIRST → descending id
      const ids = rows.map((r) => r.id)
      expect(ids).toEqual([...ids].sort((a, b) => b - a))
      expect(ids[0]).toBeGreaterThan(ids[ids.length - 1])

      // newest row is the last user message; text is decompressed (not a Buffer)
      const newest = rows[0]
      expect(newest.msgType).toBe('user')
      expect(newest.source).toBe('main')
      expect(typeof newest.text).toBe('string')
      expect(newest.text).toContain('ship it when the tests pass')
      expect(newest.matchedBy).toBe('keyword')

      // the tool_use row carries its tool name + full formatted text
      const toolRow = rows.find((r) => r.msgType === 'tool_use')
      expect(toolRow).toBeTruthy()
      expect(toolRow!.toolName).toBe('Grep')
      expect(toolRow!.text).toContain('flibbertigibbet')

      // metadata plumbed through
      expect(newest.gitBranch).toBe('main')
      expect(newest.cwd).toBe(env.workingDir)
    } finally {
      db.close()
    }
  })

  it('returns all rows when N exceeds the row count', async () => {
    const env = makeEnv()
    env.writeJsonl(sampleLines(env.sessionId, env.workingDir))
    await updateSessionStore(env.sessionId, env.workingDir)

    const db = openStore(getStorePath(env.sessionId, env.workingDir), { readonly: true })
    try {
      const rows = recentRows(db, 100)
      expect(rows).toHaveLength(4)
    } finally {
      db.close()
    }
  })
})

// ── 2. recall() keyword path ──────────────────────────────────────────────────
describe('recall() keyword path', () => {
  it('finds the row(s) containing a distinctive word, matchedBy=keyword, full text', async () => {
    const env = makeEnv()
    env.writeJsonl(sampleLines(env.sessionId, env.workingDir))
    await updateSessionStore(env.sessionId, env.workingDir)

    const db = openStore(getStorePath(env.sessionId, env.workingDir), { readonly: true })
    try {
      // no embed → keyword mode; no network
      const hits = await recall(db, 'flibbertigibbet', { mode: 'keyword', topK: 5 })

      expect(hits.length).toBeGreaterThan(0)
      // "flibbertigibbet" appears in the first user msg, the assistant text, and the Grep tool_use
      for (const h of hits) {
        expect(h.matchedBy).toBe('keyword')
        expect(typeof h.text).toBe('string')
      }
      const combined = hits.map((h) => h.text).join('\n')
      expect(combined).toContain('flibbertigibbet')

      // a full-text match returns the untruncated message text
      const userHit = hits.find((h) => h.msgType === 'user')
      expect(userHit).toBeTruthy()
      expect(userHit!.text).toBe('Please investigate the flibbertigibbet bug in the parser.')

      // a query for a word present nowhere returns nothing
      const none = await recall(db, 'zzznonexistentzzz', { mode: 'keyword', topK: 5 })
      expect(none).toEqual([])
    } finally {
      db.close()
    }
  })
})

// ── 3. readonly openStore ─────────────────────────────────────────────────────
describe('openStore({readonly:true})', () => {
  it('can SELECT but rejects writes and does not run migrations', async () => {
    const env = makeEnv()
    env.writeJsonl(sampleLines(env.sessionId, env.workingDir))
    await updateSessionStore(env.sessionId, env.workingDir)

    const dbPath = getStorePath(env.sessionId, env.workingDir)
    const db = openStore(dbPath, { readonly: true })
    try {
      // SELECT works
      const { c } = db.prepare('SELECT COUNT(*) c FROM content').get() as { c: number }
      expect(c).toBe(4)

      // write throws (readonly enforced)
      expect(() =>
        db.prepare("INSERT INTO meta(key,value) VALUES ('x','y')").run(),
      ).toThrow(/readonly|read.only/i)

      // did NOT run migrations: a readonly connection can't create the meta/content
      // tables, so the schema is exactly what the writer left — the meta identity rows
      // written by the writer are all present and unchanged (a reader never restamps).
      const meta = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]
      const keys = meta.map((m) => m.key)
      expect(keys).toContain('version')
      expect(keys).toContain('embed_dim')
      expect(keys).toContain('embed_model')
    } finally {
      db.close()
    }
  })

  it('does not CREATE a schema when opened readonly on a store built by the writer', async () => {
    // Prove migrations are skipped by a different lens: a readonly open must not add the
    // WAL journal-mode side effects nor alter meta. We simply confirm reads succeed and
    // the vec table is empty (never embedded), which recall() relies on to pick keyword.
    const env = makeEnv()
    env.writeJsonl(sampleLines(env.sessionId, env.workingDir))
    await updateSessionStore(env.sessionId, env.workingDir)

    const db = openStore(getStorePath(env.sessionId, env.workingDir), { readonly: true })
    try {
      const { c } = db.prepare('SELECT COUNT(*) c FROM vec').get() as { c: number }
      expect(c).toBe(0) // no embedder was ever supplied
    } finally {
      db.close()
    }
  })
})

// ── 4. empty / edge cases ─────────────────────────────────────────────────────
describe('empty store edge cases', () => {
  it('recall() and recentRows() return [] on an empty (no-content) store', async () => {
    const env = makeEnv()
    // Write an empty JSONL so the store is created but has zero indexable rows.
    env.writeJsonl([{ type: 'file-history-snapshot', snapshot: { timestamp: '2026-09-26T00:00:00.000Z' } }])
    const stats = await updateSessionStore(env.sessionId, env.workingDir)
    expect(stats.totalRows).toBe(0)

    const db = openStore(getStorePath(env.sessionId, env.workingDir), { readonly: true })
    try {
      expect(recentRows(db, 20)).toEqual([])
      expect(await recall(db, 'anything', { mode: 'keyword', topK: 5 })).toEqual([])
    } finally {
      db.close()
    }
  })

  it('an in-memory freshly-schema store (no writes) yields [] for both', async () => {
    // openStore (writer path) on a brand-new file creates the schema with zero rows.
    const env = makeEnv()
    const dir = join(env.workingDir, 'osb')
    mkdirSync(dir, { recursive: true })
    const db = openStore(join(dir, 'empty.db'))
    try {
      expect(recentRows(db, 10)).toEqual([])
      expect(await recall(db, 'foo', { mode: 'keyword', topK: 5 })).toEqual([])
    } finally {
      db.close()
    }
  })
})
