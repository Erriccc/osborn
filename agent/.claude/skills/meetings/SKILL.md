# Skill: Meetings

Silent note-taking and TODO-tracking when osborn is sitting in a live meeting,
and explicit on-demand transcript pulls from Recall.ai when the user asks.

## When to use

Two trigger patterns:

**1. Auto-tagged meeting transcript chunks** (every ~30s while a Recall bot is active):
   Any user message that starts with `[MEETING — <botId>]:`. Also a `[SYSTEM] You are now in a meeting ...` injection on bot join.

**2. Explicit user request to pull / write notes** (any of these keyphrases in voice-native chat):
   - "grab the meeting transcripts"
   - "pull the meeting transcripts"
   - "fetch the meeting transcripts"
   - "what was said in the meeting"
   - "update the meeting notes"
   - "compile the todos"
   - "write the todos"
   - "summarize the meeting"

**Do NOT use this skill** for normal user voice-native messages that don't fit those patterns — those get spoken responses as usual.

## How to behave (auto-tagged chunks)

For every `[MEETING — *]:` message:

1. **Do NOT speak.** No TTS output. No conversational reply.
2. **Update `meeting-todos.md`** in the session workspace. Append new action items, decisions, open questions. One file, evolving.
3. **Optionally trigger background research silently** via Task tool.
4. **Don't consume voice-native attention.** The user can interrupt with a voice-native message at any time — that's the only kind that gets spoken responses.

## How to pull transcripts on demand (Bash + curl)

When the user explicitly asks (see triggers above), run these commands. Speak briefly first ("On it"), do the work, then speak the result.

### Step 1: Get the bot ID

The bot ID is in `meeting-todos.md` on the `**Bot:**` line. If `meeting-todos.md` doesn't exist (user is asking about a meeting that already ended in a prior session), ask the user for the bot ID or meeting URL.

### Step 2: Fetch the bot record

```bash
curl -sS \
  -H "Authorization: Token ${RECALL_API_KEY}" \
  "https://us-west-2.recall.ai/api/v1/bot/<BOT_ID>"
```

**CRITICAL**: The endpoint MUST be `us-west-2.recall.ai`, NOT the default `recall.ai` or `us-east-1.recall.ai`. The osborn account is provisioned in the us-west-2 region. Using the default endpoint returns 401 "OAuth authentication is currently not supported" or region-mismatch errors.

`${RECALL_API_KEY}` is preset in the agent's env — pass it through. Do NOT echo or print the raw key value in your response.

### Step 3: Extract the transcript download URL

Parse the JSON response. The transcript's pre-signed S3 URL lives at:

```
recordings[0].media_shortcuts.transcript.data.download_url
```

Pipe through `jq` if needed:

```bash
DOWNLOAD_URL=$(curl -sS \
  -H "Authorization: Token ${RECALL_API_KEY}" \
  "https://us-west-2.recall.ai/api/v1/bot/<BOT_ID>" \
  | jq -r '.recordings[0].media_shortcuts.transcript.data.download_url')
```

If `recordings[0]` doesn't exist yet, the meeting hasn't been processed — return "the recording isn't ready yet, give it a minute" and stop.

### Step 4: Download the transcript JSON

```bash
curl -sS "$DOWNLOAD_URL" -o /tmp/meeting-transcript.json
```

The download URL is a pre-signed S3 link that **expires** (typically ~6 hours after issue). If you get a 403 or AccessDenied, re-fetch the bot record (step 2) to get a fresh URL.

### Step 5: Parse and distill into meeting-todos.md

The transcript JSON is an array of turns. Each turn has `participant.name` and `words[]` (each word has `text` + `start_timestamp.relative`). Concatenate words per turn to get the utterance.

Use `jq` to pull turns into readable lines:

```bash
jq -r '.[] | "\(.participant.name // "Unknown"): \(.words | map(.text) | join(" "))"' /tmp/meeting-transcript.json
```

Then update `meeting-todos.md` — distill into TODOs / Decisions / Open Questions sections. Don't paste the whole transcript verbatim into the file; summarize.

## The `meeting-todos.md` file

Path: `{session_workspace}/meeting-todos.md` — get the workspace path from spec.md or from the `[SYSTEM]` injection.

Keep it scannable. Structure:

```markdown
# Meeting Notes

**Bot:** <botId>
**Started:** <ISO timestamp>
**URL:** <meeting URL>

## Summary
<3-5 sentences distilling the meeting after it ends — added LAST>

## TODOs
- [ ] <person>: <action item> — <context>

## Decisions
- <what was decided> (raised by <person>)

## Open Questions
- <question> — raised by <person>, still unresolved

## Highlights
- <key moment or quote worth surfacing>
```

Update the same file across all updates — one file, evolving. Don't create `meeting-todos-1.md`, `meeting-todos-2.md`.

## On meeting end

When `[MEETING — *]:` messages stop OR the system says `[SYSTEM] meeting ended`:
- Pull the full final transcript (step 2-4 above)
- Add a `## Summary` section at the top with 3-5 lines
- Mark resolved open questions
- The next user voice-native question may be "what was the meeting about?" — answer normally (speak) from the updated file

## When the user asks about the meeting in voice-native

When a non-meeting-tagged voice message references the meeting ("what's on the todo list?", "what did we decide about X?"), respond normally — **speak** the answer. Read `meeting-todos.md` first to ground the response. If `meeting-todos.md` is empty or missing relevant detail, pull a fresh transcript first (steps 2-4) and update the file, then answer.

## Anti-patterns

- ❌ Using `recall.ai` or `us-east-1.recall.ai` — always `us-west-2.recall.ai`
- ❌ Using `WebFetch` for the S3 download URL — use `curl` via `Bash` (the URL has weird chars + pre-signed query strings that confuse WebFetch)
- ❌ Pasting the full raw transcript into `meeting-todos.md`
- ❌ Speaking in response to `[MEETING — *]:` messages
- ❌ Asking clarifying questions during a live meeting
- ❌ Creating a new file per pull instead of updating one
- ❌ Re-pulling the bot record over and over inside one user turn — fetch once, parse once
- ❌ Echoing or printing `${RECALL_API_KEY}` value in your response
