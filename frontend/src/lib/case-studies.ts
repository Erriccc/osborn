/**
 * Case studies — grounded, real work Voice Native has executed by voice.
 *
 * These are editorial write-ups of actual sessions (problem → approach → outcome).
 * No invented metrics. Consumed by /use-cases and /use-cases/[slug], both SSR.
 *
 * Keep this the single source of truth so the dynamic route and any index can
 * share the same records (title/slug/SEO text).
 */

export interface CaseStudySection {
  /** Short eyebrow label rendered above the heading (mono, amber). */
  kicker: string
  heading: string
  /** One or more paragraphs of body copy. */
  body: string[]
}

export interface CaseStudy {
  slug: string
  /** Page <title> and hero headline. */
  title: string
  /** Hero sub-line / one-sentence summary. */
  summary: string
  /** <meta name="description"> + OG description. Plain, <=160 chars ideally. */
  seoDescription: string
  /** Mono eyebrow on the hero (e.g. "Growth automation"). */
  category: string
  /** Quick facts shown as a chip row under the hero. */
  facts: { label: string; value: string }[]
  /** Editorial body: problem → approach → outcome (and optional extras). */
  sections: CaseStudySection[]
  /** Pull-quote rendered mid-page. Optional. */
  pullQuote?: string
}

export const CASE_STUDIES: CaseStudy[] = [
  {
    slug: 'google-ads-automation',
    title: 'Getting Google Ads running end-to-end on a manager account',
    summary:
      'A founder wanted ads live without hand-holding a console. Voice Native stood the whole flow up by voice — manager account, founder-account creation, and a launch model safe enough to trust.',
    seoDescription:
      'How Voice Native built end-to-end Google Ads automation on a manager account by voice: founder-account creation, a safe single-switch launch, and a resume-cascade fix.',
    category: 'Growth automation',
    facts: [
      { label: 'Surface', value: 'Google Ads (manager / MCC)' },
      { label: 'Interface', value: 'Voice' },
      { label: 'Shape', value: 'Account setup → safe launch' },
    ],
    pullQuote:
      'The whole thing was described out loud — no console clicking, no copy-pasted API snippets. The agent held the account model in its head and I just talked.',
    sections: [
      {
        kicker: 'The problem',
        heading: 'Google Ads is powerful and unforgiving',
        body: [
          'Running paid acquisition through a manager (MCC) account means juggling account hierarchy, the Google Ads API, authentication, and a launch surface where one wrong toggle spends real money. For a founder, the setup tax alone is enough to stall for weeks — and the console does not protect you from launching the wrong thing.',
          'The goal was simple to say and hard to do safely: get ads actually running, end to end, on a manager account, without a human babysitting every step of the console.',
        ],
      },
      {
        kicker: 'The approach',
        heading: 'Describe the account model out loud; let the team build it',
        body: [
          'The founder talked through what they wanted. Voice Native dispatched its sub-agents against it: the Researcher pulled the current state of the manager account and the API surface, the Reasoner worked out the correct account hierarchy, and the Writer implemented founder-account creation under the manager so campaigns had a real home to live in.',
          'Rather than hand back a wall of API calls to run manually, the agent executed against the account on the founder’s own infrastructure and reported what it changed as it went — visible, step by step, with the ability to cut in by voice at any point.',
          'The launch itself was deliberately designed to be boring and safe: a single-switch model where one control arms or disarms a launch, so going live is one intentional action instead of a dozen fragile toggles.',
        ],
      },
      {
        kicker: 'The complication',
        heading: 'A resume cascade kept re-enabling paused campaigns',
        body: [
          'Early on, a nasty footgun surfaced: resuming activity cascaded down the hierarchy and re-enabled child campaigns the founder had intentionally paused. Left alone, that quietly turns spend back on behind your back — exactly the kind of failure that erodes trust in automation.',
          'Voice Native traced the cascade, isolated where resume was propagating, and corrected the behavior so a founder-paused child stays paused. The single-switch launch model became the one deliberate on/off — and nothing downstream could silently override it.',
        ],
      },
      {
        kicker: 'The outcome',
        heading: 'Ads live, on a model the founder can actually trust',
        body: [
          'Google Ads ended up working end-to-end on the manager account: founder account created, campaigns able to launch, and a single safe switch to control going live. The resume-cascade bug — the one that re-enabled paused campaigns — was fixed so the launch model held.',
          'The whole thing was set up by talking to the agent, running on the founder’s own account and keys, with every change observable as it happened.',
        ],
      },
    ],
  },
  {
    slug: 'linkedin-campaign-launch',
    title: 'Extending one safe launch model from Google Ads to LinkedIn',
    summary:
      'Once the "one off-switch, everything else on" model worked for Google Ads, the natural next ask was: do the same for LinkedIn. Voice Native carried the pattern across by voice.',
    seoDescription:
      'How Voice Native extended its unified single-switch "one off-switch, everything else on" launch model from Google Ads to LinkedIn campaigns — by voice, on the founder’s own accounts.',
    category: 'Growth automation',
    facts: [
      { label: 'Surface', value: 'LinkedIn campaigns' },
      { label: 'Interface', value: 'Voice' },
      { label: 'Shape', value: 'Reuse a proven launch model' },
    ],
    pullQuote:
      'The win was consistency: the same mental model — one switch off, everything else on — now covers two ad platforms instead of one.',
    sections: [
      {
        kicker: 'The problem',
        heading: 'Two ad platforms, two different launch surfaces',
        body: [
          'With Google Ads live on a safe single-switch model, the founder wanted LinkedIn campaigns launched the same way. The risk in doing it ad-hoc is drift: a second platform with its own launch quirks means a second set of footguns, and no shared mental model for what "go live" actually does.',
          'The ask was to extend the unified launch model — one off-switch, everything else on — so LinkedIn behaved like Google Ads rather than like a brand-new, separately-reasoned system.',
        ],
      },
      {
        kicker: 'The approach',
        heading: 'Carry the pattern, not just the code',
        body: [
          'Because Voice Native keeps persistent memory of the project, the Google Ads launch model was already understood context — not something that had to be re-explained. The founder described the LinkedIn goal by voice, and the agent reasoned about how the same single-switch contract mapped onto LinkedIn’s campaign surface.',
          'The Writer extended the existing launch model to cover LinkedIn so the control semantics stayed identical across both platforms: one deliberate switch to arm a launch, everything else left on. The work ran on the founder’s own accounts and keys, reported as it went.',
        ],
      },
      {
        kicker: 'The outcome',
        heading: 'One launch model, now spanning Google Ads and LinkedIn',
        body: [
          'LinkedIn campaign launch came online under the same unified model as Google Ads. The founder got one consistent way to think about going live across both channels — a single off-switch with everything else on — instead of two separate, bespoke launch flows to keep in their head.',
          'Reusing the pattern (rather than reinventing it per platform) is exactly what persistent project memory makes possible: the second platform inherited the hard-won safety of the first.',
        ],
      },
    ],
  },
  {
    slug: 'automated-content-pipeline',
    title: 'Turning months of raw voice sessions into publishable content',
    summary:
      'Voice Native built the content pipeline behind the pages you are reading: a library that turns real session history into on-demand, SEO-ready pages.',
    seoDescription:
      'How Voice Native built an automated content pipeline: a library that turns months of raw voice-session work into on-demand, publishable, SEO content — the system behind these very pages.',
    category: 'Content automation',
    facts: [
      { label: 'Surface', value: 'Content library' },
      { label: 'Interface', value: 'Voice' },
      { label: 'Shape', value: 'Session history → publishable pages' },
    ],
    pullQuote:
      'The proof is self-referential: this very page was produced through the pipeline it describes.',
    sections: [
      {
        kicker: 'The problem',
        heading: 'Months of real work, trapped in session transcripts',
        body: [
          'Every voice session with the agent generates a genuine record of work done — problems solved, decisions made, bugs fixed. That history is a goldmine for marketing and SEO, but it sits as raw transcripts: too unstructured to publish and far too much to hand-write into pages on a regular cadence.',
          'The goal was to turn that accumulated session work into publishable, SEO-ready content on demand — without a human manually mining transcripts every time something ships.',
        ],
      },
      {
        kicker: 'The approach',
        heading: 'A library that refines sessions into pages',
        body: [
          'Voice Native built a content library that sits on top of its own session history. The Researcher surfaces the relevant work from past sessions, the Reasoner shapes it into a narrative with a real hook and structure, and the Writer produces clean, publishable copy with SEO metadata — all driven by voice and reviewable before anything goes live.',
          'Because the raw material is the product’s actual work, the output stays grounded: the pages describe things that genuinely happened rather than invented marketing claims.',
        ],
      },
      {
        kicker: 'The outcome',
        heading: 'On-demand, publishable, SEO content — grounded in real work',
        body: [
          'The result is a repeatable pipeline that converts months of voice-session history into on-demand, publishable content with the SEO plumbing already in place. New pages can be produced from real work instead of written from scratch.',
          'This set of case-study and comparison pages is itself an output of that system — the most honest demonstration of the pipeline is that it built the page you are reading.',
        ],
      },
    ],
  },
  {
    slug: 'meeting-to-action',
    title: 'Joining a meeting and turning "we should fix X" into real work',
    summary:
      'Voice Native can join a Zoom or Google Meet as a participant, follow the conversation, and carry a decision straight into code — closing the gap between a call and a commit.',
    seoDescription:
      'How Voice Native joins a Zoom or Google Meet as a bot, captures decisions in the room, and turns "we should fix X" into actual work on your machine — meeting-aware AI coding.',
    category: 'Meeting-aware agent',
    facts: [
      { label: 'Surface', value: 'Zoom / Google Meet' },
      { label: 'Interface', value: 'Voice' },
      { label: 'Shape', value: 'Decision → action' },
    ],
    pullQuote:
      'The decision and the work happen in the same place: you talk it through in the room, and it is already becoming code.',
    sections: [
      {
        kicker: 'The problem',
        heading: 'Decisions die between the call and the keyboard',
        body: [
          'A lot of work is decided in meetings and then lost in translation: someone says "we should fix X," everyone nods, and it either never gets written down or gets filed as a ticket that drifts for weeks. The gap between the room where a decision is made and the place where the work actually happens is where momentum goes to die.',
          'The goal was to collapse that gap — have an agent present in the conversation that can carry a decision directly toward action.',
        ],
      },
      {
        kicker: 'The approach',
        heading: 'Put the agent in the room',
        body: [
          'Voice Native can join a Zoom or Google Meet as a participant and follow the conversation the way a teammate would. When the discussion lands on something actionable — "we should fix X" — it can capture that decision and turn it into real work on your machine, dispatching its sub-agents to research, reason, and write against the actual codebase.',
          'Because the agent is voice-native and runs on your own infrastructure, the meeting and the work live in the same continuous context rather than being bolted together after the fact.',
        ],
      },
      {
        kicker: 'The outcome',
        heading: 'From conversation to commit, without the hand-off',
        body: [
          'The decisions made in a call stop evaporating. What was said in the room becomes work in progress against your code, with the same observability and voice control as any other Voice Native session.',
          'It turns a meeting from a place where work is only described into a place where work actually starts.',
        ],
      },
    ],
  },
]

export function getCaseStudy(slug: string): CaseStudy | undefined {
  return CASE_STUDIES.find((c) => c.slug === slug)
}

export function allCaseStudySlugs(): string[] {
  return CASE_STUDIES.map((c) => c.slug)
}
