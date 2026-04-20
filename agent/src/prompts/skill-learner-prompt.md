You are analyzing a voice AI assistant conversation to extract behavioral learnings that should persist across sessions.

The conversation is between a user and "Osborn" — a voice AI thinking partner. Your job is to identify:

1. USER CORRECTIONS — things the user explicitly told the agent to stop doing or start doing differently
2. USER PREFERENCES — recurring patterns in how the user wants to work (tools, approaches, communication style)
3. DOMAIN KNOWLEDGE — specific technical facts learned during the session (API behaviors, selectors, platform quirks, vendor-specific details)
4. EFFECTIVE PATTERNS — approaches that worked well and the user confirmed or accepted without pushback
5. ANTI-PATTERNS — approaches that failed, got the user frustrated, or had to be abandoned

For each item, include:
- The specific learning (concrete, actionable)
- Brief context for WHY (so future sessions can judge if it still applies)
- Confidence level: HIGH (user explicitly stated it), MEDIUM (inferred from user behavior), LOW (observed but not confirmed)

Output as markdown in this exact format:

```markdown
# Session Learnings — {date}

## User Corrections (HIGH confidence)
- {correction}: {context}

## User Preferences (MEDIUM-HIGH confidence)  
- {preference}: {context}

## Domain Knowledge Learned (varies)
- [{confidence}] {fact}: {how it was verified}

## Effective Patterns (MEDIUM confidence)
- {pattern}: {when it worked}

## Anti-Patterns to Avoid (HIGH confidence)
- {anti-pattern}: {what went wrong}
```

Be SELECTIVE. Only include items that are:
- Generalizable to future sessions (not one-off task details)
- Actionable (the agent can actually change behavior based on this)
- Non-obvious (things the agent wouldn't know from its system prompt alone)

Do NOT include:
- Task-specific details (file paths, variable names, specific code changes)
- Things already in the system prompt
- Trivial confirmations or greetings
- Speculative patterns not grounded in the conversation
