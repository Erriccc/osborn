---
name: recall
description: Query this session's full untruncated history — every message, thinking block, and tool call stored in a per-session SQLite database with keyword and semantic search via the osborn-recall command. Use when you need an earlier decision, file, error, number, or name no longer in context, or to check prior work before acting as a grounded agent.
---

# Recall

## SKILL IDENTITY
Name: recall
Install path: ~/.claude/skills/recall/SKILL.md
Portable: yes — drops into any agent's skills dir (Claude Code, osborn on Fly, other Claude Agent SDK hosts)

## WHEN THIS SKILL ACTIVATES
Whenever you need something from EARLIER in this session (or a prior session) that is
no longer in your context window. Specifically:

- The user refers to a past decision, file, error, number, or name you don't currently see
  ("what did we decide about…", "that bug from earlier", "the token we used", "remind me why…").
- You are a GROUNDED agent (researcher, reviewer, editor, planner, tester) about to act, and you
  must not contradict prior decisions or redo prior work — check the record FIRST.
- You suspect the answer was established before the last compaction.
- Anytime you would otherwise say "I don't have that in context" about this project's history.

Explicit triggers: "recall", "search the session", "what did we say about", "look back".

## CORE PRINCIPLE
This session's FULL history — every user message, assistant reply, thinking block, and tool
call, untruncated — is stored in a per-session embedded database (`session.db`: SQLite +
FTS5 keyword index + sqlite-vec semantic vectors). You do NOT grep a flat summary file and
you do NOT rely only on what's in your context window. You query the store with a fixed
command and read the real prior messages.

Prefer recalling over guessing. If a fact was ever said in this project, it is retrievable.

## HOW TO USE — the `osborn-recall` command

```
osborn-recall "<query>" [--mode hybrid|keyword|vector] [--top-k 8]
                        [--session <id> --cwd <dir> | --db <path>]
                        [--max-chars 1200] [--type user,assistant,thinking,tool_use,tool_result]
                        [--json]
osborn-recall --list [--cwd <dir>]          # list available session stores, newest first
```

- **Default is `hybrid`** — fuses keyword (BM25) + semantic (vector) ranking with RRF. Use it
  unless you have a reason not to. It finds both exact terms and paraphrases.
- **`--mode keyword`** — exact terms only; never loads the embedding model, so it's fastest.
  Use for identifiers, error strings, tokens, file paths, function names.
- **`--mode vector`** — pure semantic; use when you remember the MEANING but not the words
  ("how we backed up the machine" → finds Fly/rsync content with no shared keywords).
- **`--top-k`** — how many hits to return (default 8). Raise for a broad sweep, lower to focus.
- **Store resolution**: with no `--db`/`--session`, it picks the newest `session.db` under the
  current project. Pass `--session <id> --cwd <dir>` to target a specific past session, or
  `--db <path>` to point directly at a file. Use `--list` to see what's available.
- **`--type`** — filter to message kinds (comma-separated). E.g. `--type user` to see only what
  the user actually asked; `--type tool_use,tool_result` to find a past command and its output.

### Examples
```
# What did we decide about the deploy order?
osborn-recall "deploy order npm publish git push railway fly" --top-k 5

# Find the exact Supabase token string we used (exact match, fast)
osborn-recall "SUPABASE_PERSONAL_ACCESS_TOKEN" --mode keyword

# Semantic: remember the meaning, not the words
osborn-recall "how did we recover the lost sessions" --mode vector

# Only the user's own asks about a topic
osborn-recall "marnmorgan authenticated onboarding" --type user

# Machine-readable for programmatic use
osborn-recall "sqlite-vec int8 rowid bug" --json
```

## WORKFLOW
1. Turn the thing you're missing into a short query — include distinctive terms (names, error
   text, identifiers) for keyword strength, but plain-language is fine (hybrid handles both).
2. Run `osborn-recall "<query>"`. Read the returned hits — each is a REAL prior message with its
   source line, message type, model, and timestamp.
3. If nothing relevant: broaden the query, raise `--top-k`, or switch `--mode` (keyword↔vector).
   If still empty, `--list` to confirm a store exists; the flat `search-index.txt` is the legacy
   fallback but the store is authoritative and untruncated.
4. Ground your next action in what you found. Cite the source line when it matters
   ("per L214, we settled on X").

## NOTES
- The store is written incrementally each turn, so recent messages are usually present within a
  turn or two. Very-latest exchanges may lag by one turn — that's fine, they're still in context.
- Keyword mode never downloads the embedding model; hybrid/vector load MiniLM once (~12s cold,
  cached after). If the embedder is unavailable, recall silently falls back to keyword-only.
- This skill is READ-only recall. It never writes; the pipeline owns the write path.
