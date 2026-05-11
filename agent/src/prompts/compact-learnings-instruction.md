# Pre-Compaction Instructions

Before Claude Code compacts this conversation, you MUST preserve critical context by including the following four sections at the very END of your compact summary. Be selective and specific — vague summaries are useless.

---

## Section 1: HANDOFF_STATE
Format: === HANDOFF_STATE ===
Include:
- **Current goal**: What are we building/fixing and WHY (the big-picture reason, not just the immediate task)
- **Progress**: What is done, what is in-progress, what is the very next step
- **Active facts**: Environment details mentioned in this session (API keys referenced, service URLs, version numbers confirmed, file paths that matter)
- **Test results**: What was tried, what it showed, what it ruled out

Keep this under 800 characters. This stays in the compact summary — it is NOT written to disk.
- **ANNOUNCE**: End HANDOFF_STATE with one line formatted as:
  `ANNOUNCE: <natural-language sentence for Osborn to speak aloud when resuming — mention that session memory was crystallized and how many skills/decisions were updated. Keep it to one sentence, conversational tone, like a colleague mentioning it in passing.>`

---

## Section 2: DECISIONS
Format: === DECISIONS ===
List each architectural or project decision made in this session, one per line:
- DECISION: <choice made> | RATIONALE: <why> | SCOPE: project

Only include decisions that would matter in a future session on the same project. Skip trivial choices.

---

## Section 3: SKILL_CANDIDATES
Format: === SKILL_CANDIDATES ===
For each reusable how-to procedure confirmed working in this session, emit:

--- SKILL: <kebab-case-name> ---
WHEN: <one line: when this skill applies>
STEPS:
1. ...
2. ...
VERIFIED: <exact command or observation that confirmed it works>
--- END SKILL ---

A skill is worth extracting only if: (1) it was confirmed working in this session AND (2) it would apply to future sessions on different tasks. Do NOT re-emit skills already shown in the EXISTING SKILLS section unless they need substantive updates.

---

## Section 4: BEHAVIORAL_LEARNINGS
Format: === BEHAVIORAL_LEARNINGS ===
Capture user corrections, preferences, and anti-patterns in these subsections:
USER CORRECTIONS:
USER PREFERENCES:
DOMAIN KNOWLEDGE:
EFFECTIVE PATTERNS:
ANTI-PATTERNS:

If the EXISTING LEARNED SKILLS section is shown below, merge — update outdated items, add new ones, keep confirmed ones.

---

IMPORTANT: All four sections MUST appear at the end of the compact summary even if some are empty. Empty sections should have a single line: (none this session)
