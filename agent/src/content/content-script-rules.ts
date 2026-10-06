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
  /** Dev-voice lines allowed (verbatim user rows only). */
  devLines: { min: number; max: number }
  /** The question the piece answers. */
  promise: string
  beats: string[]
}

export const TIER_TEMPLATES: Record<Tier, TierSpec> = {
  highlight: {
    tier: 'highlight',
    label: '61-90s highlight (narrated timeline)',
    minS: 61,
    maxS: 90,
    targetS: 76,
    devLines: { min: 0, max: 2 },
    promise: '"Is this possible? Here is how it went." A narrated TIMELINE of what happened, in order. NOT a chain of quotes.',
    beats: [
      'Situation: name the viewer\'s situation in one line so a stranger knows why this matters to them',
      'Goal: what the developer set out to do',
      'Attempt: the first thing tried, and what happened',
      'Turn: the real test / the failure / the surprise, explained (cause -> effect)',
      'Result: what worked, with the proof from the session',
      'Lesson: one takeaway the viewer can use',
      'Sign-off: the developer\'s name (when known) in one short closing line',
    ],
  },
  howto: {
    tier: 'howto',
    label: '~150s how-to ("if you\'re in this situation...")',
    minS: 130,
    maxS: 170,
    targetS: 150,
    devLines: { min: 2, max: 6 },
    promise: '"If you\'re in this situation, here\'s what we said, what happened, and how to do it." ONE specific, useful accomplishment, step by step.',
    beats: [
      'If you\'re in this situation: the viewer\'s concrete problem, in terms of the common problems from the research',
      'Here\'s what we said: the developer\'s own words (verbatim dev lines) with the agent\'s reply, each set up so it lands',
      'Here\'s what happened: the attempts and the failure point, cause -> effect, no gaps',
      'Here\'s how to do it: the steps that worked, concrete enough to copy',
      'Tradeoff: what this costs or when NOT to do it (from the research tradeoffs when relevant)',
      'Sign-off: the developer\'s name (when known) in one short closing line',
    ],
  },
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
  'Every quote, term and number must be understandable to that viewer: either familiar to them or explained in the line before or right after it. A quote with no context for THAT viewer fails.',
  'STORY: the cause -> effect chain must be clean. Every line is the next thing that happened or the reason for it. No unexplained jumps, numbers or version strings.',
  'Hook placement is free (start, middle or end), but the hook must be explained.',
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
]

export const AUDIENCE_RULES =
  'AUDIENCE CHECK (rules §4): for the target viewer named below, is every quote or term either already familiar to them or set up nearby ' +
  '(in the line before or right after)? A quote or term that lands with no context for THAT viewer fails. Familiar terms pass. ' +
  'Also fail an unexplained number or version string.'
