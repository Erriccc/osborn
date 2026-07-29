---
name: user-context
description: Learn and maintain a living context document about this specific user — their vocabulary, communication style, recurring topics, and decision patterns. Adapted from grill-with-docs for voice-native conversations rather than code. Use when the user wants to update their context, or run passively after meaningful sessions to capture what was learned.
---

<what-to-do>

Interview the user to build and sharpen a shared vocabulary between them and the agent.
Ask one question at a time and wait for a response before continuing.

The goal is NOT a coding spec. The goal is understanding HOW THIS PERSON communicates,
what words they use naturally, what they mean when they say things, and what matters to them.

Update `~/.claude/skills/user-context/CONTEXT.md` inline as terms and preferences are resolved.
Do not batch — capture as they happen.

</what-to-do>

<trigger-phrases>
This skill is a META operation — about building a model of the USER THEMSELVES,
not about any subject matter in the current conversation. The trigger phrases below
are intentionally specific so they cannot be confused with domain requests in any session.

- "update user context"
- "learn my language"
- "start context interview"
- "grill me on my language"
- "learn how I talk"
- "standardise my language"
- "update my context"
</trigger-phrases>

<supporting-info>

## What to capture

### Vocabulary
When the user uses a term consistently, record it. When they use multiple words
for the same thing, help them pick one. Example: if they say "the cloud machine",
"the fly machine", and "the server" interchangeably — resolve it.

### Communication style
How formal or casual are they? How much technical depth do they expect?
Do they prefer short answers or thorough ones? Do they interrupt and redirect often?

### Recurring topics
What subjects come up repeatedly? What projects, people, or concepts
are central to their world?

### Decision patterns
How do they make decisions? Do they want options presented or a direct recommendation?
Do they want to understand the why, or just the what?

## During the session

### Challenge fuzzy language
When the user uses vague or inconsistent terms, name it: "You've said both 
'voice session' and 'room' — are those the same thing to you, or different?"

### Reflect back
Periodically summarise what you've learned: "So when you say 'the agent', 
you mean the cloud process on the fly machine, not me (Claude) — is that right?"

### Update CONTEXT.md inline
When a term or preference is clarified, write it to 
`~/.claude/skills/user-context/CONTEXT.md` immediately using the format below.

## CONTEXT.md format

```md
# User Context — {user name or handle}

{One or two sentences about who this person is and what they're building.}

## Language

**Voice session**: An active connection between the user's browser and the fly machine via LiveKit. 
_Avoid_: "room" (unless referring specifically to the LiveKit room name)

**The agent**: The osborn Node.js process running on the fly machine (not Claude).
_Avoid_: "Claude", "AI", "bot" — those refer to the LLM, not the agent process.

**The dashboard**: voice-native.com — the web app frontend.
_Avoid_: "the front end", "the UI" (too generic)

## Communication style

- Prefers direct recommendations over options when the answer is clear
- Talks fast and interrupts — short answers are better unless depth is asked for
- Uses voice transcription — expects the agent to handle garbled/incomplete input gracefully
- Casual tone, first-name basis, profanity is fine

## Recurring topics

- Osborn: voice AI coding assistant built on LiveKit + Claude Agent SDK
- Fly machines: the cloud sandbox infrastructure replacing Sprites
- Sessions: Claude Code JSONL files stored in ~/.claude/projects/

## Decision patterns

- Values speed over perfection for first implementations
- Prefers understanding the root cause before applying a fix
- Wants to be told when something is irreversible before proceeding
```

## Rules

- Keep definitions tight — one or two sentences.
- Only record terms specific to this user's world. Generic concepts don't belong.
- Update the file live during the session, not at the end.
- Re-read the existing CONTEXT.md at the start of every session that touches it.

</supporting-info>
