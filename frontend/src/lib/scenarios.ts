/**
 * scenarios — the single source of truth for Voice Native's hands-free
 * "industries" / use-scenarios. Drives the /industries gallery, each dedicated
 * niche page (e.g. /drivers), and the AI image-prompt doc.
 *
 * Each scenario carries a cinematic `imagePrompt` the founder feeds into an
 * image/video generator; the produced file is dropped at `/public${image}` and
 * the <ScenarioImage> renders it (styled placeholder until it exists).
 *
 * Visual treatment (`style`): 'cabin' = first-person POV, you ARE hands-free
 * (Tesla-cabin energy); 'human' = a relaxed person, hands off, work shipping
 * across the room. Both are the directions the founder picked (B + C).
 */

export type ScenarioStyle = 'cabin' | 'human'

export interface Scenario {
  slug: string
  /** Short industry/segment label (mono eyebrow). */
  segment: string
  /** Show-don't-tell headline. */
  headline: string
  /** One-line scene — what the visitor sees/feels. */
  scene: string
  /** Visual treatment. */
  style: ScenarioStyle
  /** Public image path (16:9). Rendered if the file exists, else a placeholder. */
  image: string
  /** Cinematic AI-generation prompt for the hero image. */
  imagePrompt: string
  /** Does a dedicated landing page exist yet? (gallery links only when true) */
  page?: string
}

export const SCENARIOS: Scenario[] = [
  {
    slug: 'drivers',
    segment: 'Professional drivers',
    headline: 'Hands on the wheel. Eyes on the road. Work still ships.',
    scene: 'Between rides, on the highway, mid-commute — you talk, it builds. Legal in all 50 states, because it is just your voice.',
    style: 'cabin',
    image: '/industries/drivers.jpg',
    page: '/drivers',
    imagePrompt:
      'Cinematic first-person POV from a driver\'s seat at dusk, warm amber ambient cabin lighting, dark premium interior, hands relaxed on a steering wheel, a large glowing dashboard screen ahead softly displaying streaming code and a merged pull request, a subtle luminous voice waveform reflected on the windshield, shallow depth of field, moody high-contrast, calm and in-control mood, photorealistic, 16:9.',
  },
  {
    slug: 'meeting-room',
    segment: 'Enterprise meeting room',
    headline: 'Run the room by voice. It captures, decides, and ships the follow-ups.',
    scene: 'A boardroom talks; the agent listens to everyone, drafts the decisions, and has the work moving before the meeting ends.',
    style: 'human',
    image: '/industries/meeting-room.jpg',
    imagePrompt:
      'Cinematic wide shot of a modern enterprise glass-walled boardroom, several professionals mid-discussion around a table, a large wall screen quietly showing a live transcript turning into shipped action items and code, warm amber accent glow against cool daylight, a soft glowing voice orb on the screen, premium and calm, photorealistic, shallow depth of field, 16:9.',
  },
  {
    slug: 'gamers',
    segment: 'Gaming & streaming studios',
    headline: 'Build while you play. Talk to it mid-session, never break flow.',
    scene: 'Headset on, hands on the controls — you describe the fix out loud and it ships to your build while the match keeps going.',
    style: 'cabin',
    image: '/industries/gamers.jpg',
    imagePrompt:
      'Cinematic first-person POV at a dark RGB-lit gaming battlestation at night, hands on a controller/keyboard, a large ultrawide monitor showing a game paused beside a second panel streaming code and a deploying build, moody cyan-and-amber ambient glow, a glowing voice waveform overlay, photorealistic, high-contrast, immersive, 16:9.',
  },
  {
    slug: 'onboarding',
    segment: 'Enterprise onboarding',
    headline: 'Onboard by conversation. New hires talk; the agent walks them in.',
    scene: 'No 200-page wiki. A new engineer asks out loud and the agent sets up, explains, and ships their first change with them.',
    style: 'human',
    image: '/industries/onboarding.jpg',
    imagePrompt:
      'Cinematic shot of a relaxed new employee at a clean modern desk wearing a headset, smiling slightly while speaking, a large monitor showing a friendly guided setup and streaming code, warm natural window light with a soft amber accent, a glowing voice orb on screen, welcoming and calm, photorealistic, shallow depth of field, 16:9.',
  },
  {
    slug: 'remote-meeting-assistant',
    segment: 'Remote meeting assistant',
    headline: 'Your voice in every call. It listens, acts, and ships live.',
    scene: 'On the video call, you think out loud — the agent turns the conversation into done work before you hang up.',
    style: 'human',
    image: '/industries/remote-meeting-assistant.jpg',
    imagePrompt:
      'Cinematic over-the-shoulder shot of a person in a home office on a video call grid on a large screen, a side panel showing the agent turning the spoken conversation into shipped tasks and code, warm desk lamp glow with cool screen light, a subtle glowing voice waveform, premium and focused mood, photorealistic, shallow depth of field, 16:9.',
  },
  {
    slug: 'multi-speaker',
    segment: 'Multi-speaker collaboration',
    headline: 'One agent, a room full of voices. It hears everyone and keeps up.',
    scene: 'Several people in the same room talk over each other — the agent follows every speaker and ships what the group decides.',
    style: 'human',
    image: '/industries/multi-speaker.jpg',
    imagePrompt:
      'Cinematic shot of three or four colleagues gathered around a single large table-top screen in a warm modern workspace, all talking and gesturing, the screen showing multiple attributed voice threads merging into one stream of shipped work, warm amber ambient glow, glowing multi-source waveform visualization, energetic yet premium, photorealistic, shallow depth of field, 16:9.',
  },
]

export function getScenario(slug: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.slug === slug)
}
