---
name: bug-reporter
description: |
  File a bug report or feature request when the user describes a problem with
  Osborn itself (voice glitches, agent freezes, audio echo, session crashes,
  interrupt issues) or asks for a new Osborn feature. Posts to a local agent
  endpoint that hands the report off to the frontend, which writes it to
  Supabase. Use whenever the user describes something wrong with Osborn —
  NOT for questions about their own project code.
---

# Bug Reporter Skill

File bug reports and feature requests from inside a voice session, without
breaking the conversation. Reports land in the dev team's Supabase table for
triage from a separate Claude Code session.

## When to use this

Trigger when the user describes any of these (or similar):

**Bugs:**
- Voice quality issues — "the audio cut out", "I can't hear you", "you keep echoing", "you interrupted yourself"
- Agent malfunctions — "the agent froze", "it crashed", "it stopped responding", "you're stuck"
- Session issues — "session disconnected", "the room keeps closing", "I had to restart"
- Memory/state issues — "you don't remember", "you lost context"
- Interrupt problems — "you keep cutting yourself off", "the interrupt isn't working"
- Direct asks — "this is a bug", "file this", "report this", "let me know when it's fixed"

**Feature requests:**
- "I wish Osborn could…", "can you add…", "it would be nice if…", "feature request:"

## When NOT to use

- The user has a coding question about THEIR project — that's normal research/coding work
- The user mentions an error in code they're writing — not an Osborn bug
- The user is debugging their own logs — they're working, not reporting

## How to file

### Step 1 — confirm with the user

Don't silently file. Say something brief like:

> "Sounds like a real bug — want me to file it so the team can dig in? I'll
> include the recent logs."

If they say yes, proceed. If unsure, ask whether it's worth filing.

### Step 2 — POST to the local agent endpoint

```bash
curl -sS -X POST http://localhost:8741/report-bug \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "type": "bug",
  "severity": "medium",
  "title": "Voice cuts out mid-sentence in pipeline mode",
  "description": "User reported that the agent stops speaking mid-sentence and resumes 5 minutes later. Happens repeatedly. Started after migrating to user_state_changed handler (May 21, 0.9.39).",
  "reproduction_notes": "Speak to the agent, then go silent — audio cuts off at a sentence boundary and won't resume until mic is muted for ~2 seconds.",
  "tags": ["voice-quality", "interrupt", "echo"]
}
JSON
```

The agent endpoint:
- Generates a `reportId`
- Tails `/workspace/osborn.log` (last 500 lines)
- Pulls the last few turns from the current JSONL session
- Sends everything to the frontend via the LiveKit data channel
- Returns `{ reportId, status: "submitted" }` to you

You don't need to attach logs yourself — the agent does that automatically.

### Step 3 — confirm to the user

Briefly:

> "Filed. Bug `f4a2…` — the team will look. Want me to log anything else?"

Use the first 4 chars of the returned `reportId` as a short reference.

## Choosing severity

- `critical` — voice completely unusable, session crashes immediately, data loss
- `high` — major friction (voice keeps cutting, frequent crashes, can't connect)
- `medium` — annoying but workable (echo, occasional drops, minor UI glitches)
- `low` — nice-to-have polish, edge cases, documentation gaps, feature requests

Feature requests default to `low` unless the user describes blocking workflows.

## Title writing

Short, present-tense, specific. 6–10 words.

Good:
- "Voice cuts out mid-sentence in pipeline mode"
- "Agent echoes own speech as user interrupt"
- "Session orphaned after machine OOM auto-restart"

Bad:
- "voice bug" (too vague)
- "When I was talking the agent stopped responding and I had to..." (use description)

## What NOT to include in the description

- Don't dump the full transcript — the agent attaches a `transcript_excerpt` automatically
- Don't paste log lines — the agent attaches the `log_excerpt` automatically
- Don't speculate about the fix unless the user explicitly suggested one
- Don't include the user's API keys, OAuth tokens, or PII

## Tags vocabulary

Pick from these rough buckets (one or more):
`echo, interrupt, crash, freeze, memory, voice-quality, audio, mode-specific,
direct, pipeline, realtime, ui, sessions, fly, recall, meeting, deepgram, tts, stt`

## Reading existing reports

You don't query, list, or close reports from inside a voice session — that's
the dev team's job from their own Claude Code session. If the user asks "is
that bug fixed yet?", say "let me check" and use the same endpoint with `GET`:

```bash
curl -sS "http://localhost:8741/report-bug?id=${REPORT_ID}"
```

But typically the user won't ask, and you don't need to volunteer the status.
