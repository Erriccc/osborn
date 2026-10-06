/**
 * content-script-rules.ts — the WRITING rules, format catalog and per-tier
 * templates for Stage A. Pure data, no pipeline logic.
 *
 * This module is the drop-in point for prompt improvements: the separate
 * "what makes a video postable" analysis replaces/extends SCRIPT_RULES and the
 * TIER_TEMPLATES beats here without touching content-brief / content-script /
 * content-run. Source of truth for everything below:
 *   SYSTEM-content-rules.md (§2 catalog, §3 tiers, §4 audience, §5 story,
 *   §6 ownership, §7 grounding, §8a problem research) and
 *   SYSTEM-format-playbook-oct06.md (templates, ~2.5 words/s, audience anchor).
 */

export type Tier = 'highlight' | 'howto'

/** Spoken pace used for every length estimate (playbook: about 2.5 words/s). */
export const WORDS_PER_SECOND = 2.5

export interface TierSpec {
  tier: Tier
  label: string
  /** Hard bounds on the estimated spoken length (seconds). */
  minS: number
  maxS: number
  targetS: number
  /** Spoken-word target range from WHAT-WORKS (prompt guidance; the hard gate is minS/maxS). */
  words: { min: number; max: number }
  /** Dev-voice lines allowed (verbatim user rows only). */
  devLines: { min: number; max: number }
  /** The question the piece answers. */
  promise: string
  beats: string[]
  /** The budget line from WHAT-WORKS for this tier. */
  budget: string
}

/**
 * Templates from WHAT-WORKS-video-writing-rules.md (round 2, gate PASS).
 * Length note: the how-to's 400-440 words is ~160-176s at 2.5 words/s (renders run
 * TTS at ~1.1x tempo, i.e. ~150s on screen), so its spoken bound is 140-180s.
 */
export const TIER_TEMPLATES: Record<Tier, TierSpec> = {
  highlight: {
    tier: 'highlight',
    label: '61-90s highlight (narrated timeline)',
    minS: 61,
    maxS: 90,
    targetS: 74,
    words: { min: 155, max: 200 },
    devLines: { min: 0, max: 2 },
    promise: '"Is this possible? Here is how it went." A narrated TIMELINE of what happened, in order. NOT a chain of quotes.',
    beats: [
      'Line 1: the claim / paradox = the lesson, in plain words (not a bare number or status)',
      'Line 2: the stake as a visible quantity or verdict (the BEFORE)',
      'Line 3: setup, at most 1 new term, defined in the same line',
      'Lines 4-5: the test, and the "before" result',
      'Line 6: the cause, in one plain sentence',
      'Lines 7-8: the fix, and the "after" with the SAME quantity as line 2',
      'Line 9 (optional): a 2nd instance of the same cause, in line 6\'s words',
      'Line 10: the rule the viewer can take away',
      'Line 11: sign-off with the developer\'s name (when known)',
    ],
    budget: 'About 13 lines, 155-200 words. At most 2 causes, at most 3.5 load-bearing terms per minute (about 5 at 90s), no spoken versions or error codes, no standalone hedge.',
  },
  howto: {
    tier: 'howto',
    label: '~150s how-to ("if you\'re in this situation...")',
    minS: 140,
    maxS: 180,
    targetS: 168,
    words: { min: 400, max: 440 },
    devLines: { min: 1, max: 6 },
    promise: '"If you\'re in this situation, here\'s what we said, what happened, and how to do it." ONE specific, useful accomplishment, step by step.',
    beats: [
      'Line 1: "If you [situation], here\'s the trap: [claim]. Here\'s how we fixed ours."',
      'Lines 2-3: the situation and the stake quantity (the BEFORE), in terms of the common problems from the research',
      'Line 4: what we tried first, and its visible failure',
      'Line 5: a human reaction or quote (verbatim dev line) that sets up the next beat',
      'Line 6: the correction or surprise, restating the lesson',
      'Line 7: the mechanism in firing order (at most 8 terms, each defined)',
      'Line 8: the proof, the AFTER with the same quantity as line 2',
      'Line 9 (optional): further instances, each entered by a trigger line (a quote, "you were right", a look at the log)',
      'Line 10: "To do it yourself: One, Two, Three", each step mapping to a cause shown',
      'Line 11: sign-off with the developer\'s name (when known)',
    ],
    budget: 'About 18 lines, 400-440 words. At most 3 causes, at most 3 load-bearing terms per minute, at most one optional extra instance.',
  },
}

export interface ScriptLimits {
  /** Minimum seconds of runtime per cause (WHAT-WORKS: ~40s). */
  secondsPerCause: number
  maxCauses: Record<Tier, number>
  maxTermsPerMin: Record<Tier, number>
}

/**
 * Deterministic gate thresholds (STARTING VALUES from 12 videos + hand counts).
 * Env overrides: OSBORN_CONTENT_SECONDS_PER_CAUSE, OSBORN_CONTENT_MAX_CAUSES_HIGHLIGHT,
 * OSBORN_CONTENT_MAX_CAUSES_HOWTO, OSBORN_CONTENT_TERMS_PER_MIN_HIGHLIGHT, OSBORN_CONTENT_TERMS_PER_MIN_HOWTO.
 */
export function scriptLimits(): ScriptLimits {
  const n = (k: string, d: number) => {
    const v = Number((process.env[k] ?? '').trim())
    return (process.env[k] ?? '').trim() !== '' && Number.isFinite(v) && v > 0 ? v : d
  }
  return {
    secondsPerCause: n('OSBORN_CONTENT_SECONDS_PER_CAUSE', 40),
    maxCauses: { highlight: n('OSBORN_CONTENT_MAX_CAUSES_HIGHLIGHT', 2), howto: n('OSBORN_CONTENT_MAX_CAUSES_HOWTO', 3) },
    maxTermsPerMin: { highlight: n('OSBORN_CONTENT_TERMS_PER_MIN_HIGHLIGHT', 3.5), howto: n('OSBORN_CONTENT_TERMS_PER_MIN_HOWTO', 3) },
  }
}

export interface FormatEntry {
  id: string
  name: string
  /** What the format needs from the inputs. */
  needs: string
  beats: string
  whenToUse: string
  evidence: string
  tiers: Tier[]
}

/** Rules §2: every entry is first-class; none is the default. */
export const FORMAT_CATALOG: FormatEntry[] = [
  { id: 'narrated-timeline', name: 'Narrated timeline trailer', needs: 'one narrator voice; a clean ordered arc', beats: 'situation > goal > attempt > turn > result > lesson', whenToUse: 'a session arc with a clear before/after', evidence: 'v1 cheap-models narration (videos-test-1), user-approved style', tiers: ['highlight'] },
  { id: 'two-voice-hud', name: 'Two-voice replay with a state HUD', needs: 'a single numeric/state quantity that changes; dev + agent lines', beats: 'cold open (explained) > stakes > attempt > break + clue > fix > proof > takeaway', whenToUse: 'stories with 3+ causal steps around one quantity', evidence: 'F2 memory seam (videos-test-2): HUD made cause->effect followable', tiers: ['highlight', 'howto'] },
  { id: 'chat-log-replay', name: 'Chat/log replay with a narrator', needs: 'pivotal messages; narrator bridges', beats: 'pivotal message > rewind > context > escalating causes (each defined) > blameless close', whenToUse: 'disaster or surprise stories', evidence: 'Fang GitLab postmortem 3.61M views; F3 fleet sweep (videos-test-2)', tiers: ['highlight', 'howto'] },
  { id: 'explainer-build', name: 'Explainer screens built up progressively', needs: 'a concept the viewer lacks', beats: 'each sentence ADDS one visual, never replaces', whenToUse: 'the viewer needs a mental model first', evidence: 'Azure tokens 114k on 12.8k subs', tiers: ['highlight', 'howto'] },
  { id: 'test-scoreboard', name: 'Test and scoreboard', needs: 'a binary or numeric result', beats: 'question hook > stakes > attempt > test > scoreboard + proof > takeaway', whenToUse: 'a comparison with a clear score', evidence: 'F1 cheap models; small-creator ratio 0.05-0.4x (brand via series)', tiers: ['highlight'] },
  { id: 'two-character-dialogue', name: 'Two-character dialogue', needs: 'real back-and-forth between dev and agent', beats: 'situation > exchange > turn > resolution', whenToUse: 'the conversation itself is the story', evidence: 'AI-convo outliers (Gibberlink 14.1M); no dev-niche proof yet', tiers: ['howto'] },
  { id: 'chat-bubble', name: 'Chat-bubble / DM replay', needs: 'short dev and agent lines', beats: 'thread scrolls; narrator sets up each turn', whenToUse: 'quick exchanges that read well as text', evidence: 'under-supplied in dev niche (no data)', tiers: ['highlight', 'howto'] },
  { id: 'audiogram', name: 'Audiogram (waveform + captions)', needs: 'TTS or real audio; captions', beats: 'one continuous spoken thread', whenToUse: 'a monologue-style explanation', evidence: 'catalog (untested)', tiers: ['howto'] },
  { id: 'podcast-clip', name: 'Animated or avatar podcast clip', needs: 'two voices', beats: 'host frames > guest explains > host lands it', whenToUse: 'interview-style how-to', evidence: 'catalog (untested)', tiers: ['howto'] },
  { id: 'unrelated-footage', name: 'Audio over unrelated footage', needs: 'a self-contained narrated track', beats: 'narration carries everything', whenToUse: 'broad-audience retention play', evidence: 'catalog (untested in dev niche)', tiers: ['highlight'] },
  { id: 'phone-call', name: 'Phone-call style', needs: 'two voices, short turns', beats: 'call opens on the problem > back-and-forth > resolution', whenToUse: 'a help-desk style fix', evidence: 'catalog (untested)', tiers: ['howto'] },
]

/** Writing rules shared by every script prompt (rules §4, §5, §7). */
export const SCRIPT_RULES: string[] = [
  'WHO: write to the named viewer, someone living the situation. Context, not explaining every line: terms they already know need no setup; anything outside their world gets just enough setup nearby.',
  'Every quote, term and number must be understandable to that viewer: either already known to that viewer or explained in the line before or right after it. A quote with no context for THAT viewer fails.',
  'STORY: the cause -> effect chain must be clean. Every line is the next thing that happened or the reason for it. No unexplained jumps, numbers or version strings.',
  'Hook placement is free (start, middle or end), but the hook must be explained.',
  // WHAT-WORKS-video-writing-rules.md (round 2, gate PASS): the rules that separate postable videos from incoherent ones.
  'STAKE AND PROOF, BOTH VISIBLE: show the problem as a quantity or verdict (the brief\'s stake BEFORE), then the SAME quantity after the fix (AFTER). E.g. 0/4 -> 4/4; bar full -> one fire; zero markers -> reject.',
  'TERMS: at most ~3.5 load-bearing terms per minute (how-to: ~3), each defined in the line where it first appears.',
  'CAUSES: at least ~40 seconds per cause. A cause is a distinct fault or catch needing its own fix. Under 60s: 1 cause; 61-90s: at most 2 (the 2nd only if it repeats the 1st\'s cause); ~150s: at most 3, each an instance of the lesson. Cut unrelated catches.',
  'NO spoken software versions or error codes as story beats (no "0.9.73", "v2.1", "HTTP 502", "1006", "ENOENT") outside a verbatim dev line.',
  'The CLAIM lands by line 2, in plain words. Do not open on a bare number or status. No standalone hedges.',
  'GROUNDING: every claim must come from the SESSION material or the RESEARCH given. Never invent numbers, names, products, results or people. If unsure, leave it out.',
  'Speak to the problems the research shows people actually hit; frame the solution against them.',
  'DEV VOICE: speaker "dev" lines are copied VERBATIM from ONE user row given (same characters; you may cut words with " … " but every kept piece must be 12+ characters and the cuts must not change the meaning). Put that row number in "row". Never put the assistant\'s findings, or anything paraphrased, in the dev voice.',
  'Speaker "agent" lines restate what the assistant did or found, plainly. Speaker "narrator" carries the timeline.',
  'Client work stays redacted: keep tags like [client] as they are, never guess or reintroduce names, companies, IDs or amounts.',
  'No secrets, keys, tokens, emails, URLs to private systems, or personal details.',
  'Plain spoken English, short sentences, no markdown, no emojis, no stage directions inside "text".',
]

export const BRIEF_RULES: string[] = [
  'Every brief starts with WHO is consuming it and what they are living through, picked from the research (who is living through it / common problems).',
  'One highlight per period at most; how-tos only where the session shows ONE specific, useful accomplishment someone could copy.',
  'Pick the format from the catalog by fit (what it needs vs. what the session has). No format is the default.',
  'Pick the stretch of the session (row range) the piece is built from; dev lines can only come from user rows in it.',
  'STAKE: name the before -> after quantity or verdict the piece will SHOW (e.g. "facts recalled: 0/4 -> 4/4"), taken from the session. If the story has no provable before/after in the session, leave stake empty — it will not be scripted.',
]

export const AUDIENCE_RULES =
  'AUDIENCE CHECK (rules §4): for the target viewer named below, is every quote or term either already familiar to them or set up nearby ' +
  '(in the line before or right after)? A quote or term that lands with no context for THAT viewer fails. Familiar terms pass. ' +
  'Also fail an unexplained number or version string.'
