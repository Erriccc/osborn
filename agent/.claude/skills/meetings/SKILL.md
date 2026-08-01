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

## CRITICAL: delegate the file + transcript work to the `writer` sub-agent

The main orchestrator agent has a **hard limit of 3 direct tool calls per turn** (enforced in PreToolUse — Read/Write/Bash/Glob are DENIED after the 3rd call). Writing `meeting-todos.md` and pulling transcripts (curl + jq + Write) is far more than 3 calls, so **doing it directly gets you blocked** ("all tools blocked").

**Sub-agents are exempt from this budget and have full permissions.** So for ALL meeting file/transcript work, **delegate to the `writer` sub-agent in ONE `Task` call** and let it do the whole job (fetch transcript, parse, write `meeting-todos.md`). That's a single tool call for you, and the writer has no budget cap.

```
Task(
  subagent_type: 'writer',
  run_in_background: true,   // silent — don't block voice
  description: 'update meeting-todos.md',
  prompt: '<the full instructions below: workspace path, bot ID, what to fetch/parse/write>'
)
```

Give the writer everything it needs in the prompt: the session-workspace path, the bot ID, the `us-west-2.recall.ai` endpoint rule, and the `meeting-todos.md` structure. The writer runs the curl/jq/Write steps itself. For research, delegate to the `researcher` sub-agent the same way.

## How to SPEAK INTO the meeting (out of silent mode)

You can talk directly into the Google Meet / Zoom — your words play as the bot's
voice. The bot casts a "meeting canvas" webpage as its camera+mic; POSTing to
your own HTTP API pushes speech (and visuals) to it, and Recall pipes the
canvas audio into the call. This is ONE Bash call, within budget.

**Speak into the meeting:**
```bash
curl -sS -X POST http://localhost:8741/canvas -H 'Content-Type: application/json' \
  -d '{"kind":"say","text":"YOUR WORDS HERE"}'
```
(Port is `OSBORN_API_PORT`, default 8741.)

**Show a visual on the bot's camera** (notes, a link, a title):
```bash
curl -sS -X POST http://localhost:8741/canvas -H 'Content-Type: application/json' \
  -d '{"kind":"show","mode":"notes","title":"...","items":["...","..."]}'
```
`mode` = `idle` | `notes` (title+items) | `link` (url) | `web` (iframe url) | `text` (title+text)
| `stream` (url — renders `<img src="{url}/stream">`, a live MJPEG browser feed).

**`stream` mode — NO TUNNELS policy:** the feed URL must be PUBLIC. Never
tunnel a local browser engine to get one (ngrok's free tier burned its entire
monthly bandwidth cap on one continuous-MJPEG demo — `ERR_NGROK_725`). Run the
browser-screen-recorder engine on its Fly machine instead; its `:8080` MJPEG is
already public at `https://<app>.fly.dev/`. See the browser-screen-recorder
skill ("Casting the feed into a meeting") for details.

**When to speak into the meeting:** By DEFAULT stay silent (observer) for
`[MEETING — *]:` chunks — take notes, don't interrupt. Speak into the meeting
ONLY when: (a) the voice-native user explicitly tells you to say something to the
meeting / "tell them X" / "answer that", or (b) you're directly addressed by name
in the meeting and the user has enabled active mode. When you do speak, keep it
short and let the room continue. This is the toggle between silent-observer and
active-participant.

## How to behave (auto-tagged chunks)

For every `[MEETING — *]:` message:

1. **Do NOT speak.** No TTS output. No conversational reply.
2. **Delegate to the `writer` sub-agent** (see above) to append new action items, decisions, and open questions to `meeting-todos.md`. Do NOT write the file yourself — you'll hit the 3-call budget and get blocked. Batch chunks if they arrive faster than the writer finishes; one evolving file.
3. **Delegate research to the `researcher` sub-agent** via `Task` (background, silent) when a chunk warrants it.
4. **Don't consume voice-native attention.** The user can interrupt with a voice-native message at any time — that's the only kind that gets spoken responses.

## ADDRESSED turns: REPLY FIRST, notes after (latency rule)

When a chunk says **`YOU WERE ADDRESSED`**, people in the meeting are WAITING
for your voice. Measured failure (2026-08-01): notes-writing inside the reply
turn pushed speech→reply past 30 seconds ("very very delayed").

**Mandatory turn shape when addressed:**
1. **FIRST tool call = the `/canvas say` POST.** One short spoken reply (1–2
   sentences, conversational). Nothing runs before it — no Read, no Edit, no
   transcript pull, no sub-agent.
2. **THEN** delegate note-taking / research to the writer/researcher
   sub-agents in the background as usual.
3. If you genuinely need a fact before answering, say a holding line FIRST
   ("Good question — one second while I check"), then look it up, then follow
   up with a second `/canvas say`. Never leave the room in silence while you
   work.

## Browse requests while CASTING a live stream — drive the ENGINE, not the canvas

When the canvas is in **`stream` mode** (bot camera = the live
browser-screen-recorder feed), requests like "pull up YouTube", "show them the
site", "navigate to X" mean: **make the STREAMED BROWSER go there.** Do NOT
flip the canvas to `link`/`web` mode — that silently replaces the live browser
feed with a static card (observed failure 2026-08-01: "PULLING UP youtube.com"
card replaced the stream).

**Drive the engine** (one Bash call, needs `OSBORN_ENGINE_TOKEN` env):
```bash
curl -sS -X POST "https://osborn-voice-e2e.fly.dev:8781/act" \
  -H "x-engine-token: $OSBORN_ENGINE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"instruction":"go to youtube.com"}'
```
(Or `/tab {"op":"open","url":"https://youtube.com"}` for a direct open. The
cast keeps showing a REAL browser doing the thing — that's the product.)

If `OSBORN_ENGINE_TOKEN` isn't set, SAY so ("I can't reach the browser engine
from here — the engine token isn't configured on this machine") instead of
downgrading the cast. Only use canvas `link`/`web` mode when there is NO
active stream cast, or the user explicitly asks for a card instead.

## How to pull transcripts on demand (Bash + curl)

When the user explicitly asks (see triggers above): speak briefly first ("On it"), then **delegate the fetch+parse+write to the `writer` sub-agent** in one `Task` call (the steps below are what you put in the writer's prompt — they're 4+ Bash/Write calls, over your 3-call budget). When the writer finishes, speak the result. The commands below are the recipe the writer runs, not calls you make directly.

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
