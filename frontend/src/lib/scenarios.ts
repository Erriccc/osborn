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
    headline: 'The meeting ends. The work’s already done.',
    scene: 'The room talks over itself. It catches every decision and ships the follow-ups before anyone stands up.',
    style: 'human',
    image: '/industries/meeting-room.jpg',
    imagePrompt:
      'Cinematic wide shot of a modern enterprise glass-walled boardroom, several professionals mid-discussion around a table, a large wall screen quietly showing a live transcript turning into shipped action items and code, warm amber accent glow against cool daylight, a soft glowing voice orb on the screen, premium and calm, photorealistic, shallow depth of field, 16:9.',
  },
  {
    slug: 'gamers',
    segment: 'Game studios & streamers',
    headline: 'Call the shot. It ships before you respawn.',
    scene: 'Headset on, hands on the controls. You say the fix out loud and it lands in the build without ever pausing the match.',
    style: 'cabin',
    image: '/industries/gamers.jpg',
    imagePrompt:
      'Cinematic first-person POV at a dark RGB-lit gaming battlestation at night, hands on a controller/keyboard, a large ultrawide monitor showing a game paused beside a second panel streaming code and a deploying build, moody cyan-and-amber ambient glow, a glowing voice waveform overlay, photorealistic, high-contrast, immersive, 16:9.',
  },
  {
    slug: 'onboarding',
    segment: 'Enterprise onboarding',
    headline: 'Day one. First commit. Just by talking.',
    scene: 'No 200-page wiki. The new hire asks out loud; it sets up their machine, explains the codebase, and ships their first change with them.',
    style: 'human',
    image: '/industries/onboarding.jpg',
    imagePrompt:
      'Cinematic shot of a relaxed new employee at a clean modern desk wearing a headset, smiling slightly while speaking, a large monitor showing a friendly guided setup and streaming code, warm natural window light with a soft amber accent, a glowing voice orb on screen, welcoming and calm, photorealistic, shallow depth of field, 16:9.',
  },
  {
    slug: 'remote-meeting-assistant',
    segment: 'Remote meeting assistant',
    headline: 'Think out loud on the call. Hang up to find it done.',
    scene: 'It sits in on the video call, follows the conversation, and turns what you say into shipped work before anyone leaves.',
    style: 'human',
    image: '/industries/remote-meeting-assistant.jpg',
    imagePrompt:
      'Cinematic over-the-shoulder shot of a person in a home office on a video call grid on a large screen, a side panel showing the agent turning the spoken conversation into shipped tasks and code, warm desk lamp glow with cool screen light, a subtle glowing voice waveform, premium and focused mood, photorealistic, shallow depth of field, 16:9.',
  },
  {
    slug: 'multi-speaker',
    segment: 'Multi-speaker collaboration',
    headline: 'A room full of voices. One agent keeps up with all of them.',
    scene: 'Several people in the same room, talking over each other. It tells them apart, follows every thread, and ships what the group lands on.',
    style: 'human',
    image: '/industries/multi-speaker.jpg',
    imagePrompt:
      'Cinematic shot of three or four colleagues gathered around a single large table-top screen in a warm modern workspace, all talking and gesturing, the screen showing multiple attributed voice threads merging into one stream of shipped work, warm amber ambient glow, glowing multi-source waveform visualization, energetic yet premium, photorealistic, shallow depth of field, 16:9.',
  },
]

export function getScenario(slug: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.slug === slug)
}
