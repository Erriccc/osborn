/**
 * seed-chat — shared helpers for launching a chat SEEDED with content.
 *
 * No new API, no new session route: we stash a (possibly long) seed prompt in
 * sessionStorage and navigate to the normal /chat flow with ?seed=1. The
 * ChatSessionProvider reads it and VoiceRoom auto-sends it once on connect,
 * then clears it. This powers "Talk about it" (public pages) and chat-based
 * "Refine for X" (library) alike.
 */

// A dedicated project folder so seeded/shared sessions land in one place
// instead of the base workspace. The agent boots here (creating it if needed).
export const SHARED_CWD = '/workspace/Shared'

export const SEED_KEY = 'voice-native-seed'

export interface RefinePlatform {
  id: string
  label: string
  instruction: string
}

/** Platform forks — each seeds the chat with a format-specific instruction. */
export const REFINE_PLATFORMS: RefinePlatform[] = [
  {
    id: 'blog',
    label: 'Blog post',
    instruction:
      'Rewrite the source below into a polished, SEO-friendly blog post: a strong headline, a one-line hook, clear H2 sections, and a short meta description. Drop any raw logs, row numbers, or verification noise — keep the real story.',
  },
  {
    id: 'x_thread',
    label: 'X thread',
    instruction:
      'Rewrite the source below into an X/Twitter thread: a scroll-stopping first tweet, then numbered tweets each under 270 characters, ending with a CTA. Plain, punchy, no hype.',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn post',
    instruction:
      'Rewrite the source below into a professional LinkedIn post: a hook first line, short scannable paragraphs, a concrete takeaway, and one clear call to action.',
  },
  {
    id: 'short',
    label: 'Short script',
    instruction:
      'Rewrite the source below into a 60–90 second short-video script: a 1-line hook, then a tight spoken script in short lines. Conversational, confident.',
  },
  {
    id: 'newsletter',
    label: 'Newsletter',
    instruction:
      'Rewrite the source below into a newsletter issue: a subject line, a preview line, and a well-structured body with a clear takeaway and CTA.',
  },
]

/** Build a chat URL that will auto-send `seed` once on connect. */
export function buildSeededChatUrl(seed: string): string {
  try {
    sessionStorage.setItem(SEED_KEY, seed.slice(0, 20000))
  } catch {
    /* sessionStorage unavailable — the chat just won't be pre-filled */
  }
  const p = new URLSearchParams({ seed: '1', workingDirectory: SHARED_CWD })
  return `/chat?${p.toString()}`
}

/** Compose a refine seed from a platform instruction + the source content. */
export function refineSeed(
  platform: RefinePlatform,
  item: { title?: string | null; body?: string | null },
): string {
  return `${platform.instruction}\n\nWhen you have a version I like, save it and offer to publish it.\n\n--- SOURCE ---\nTitle: ${item.title ?? 'Untitled'}\n\n${item.body ?? ''}`
}

/** Compose a "talk about it" seed for a public page. */
export function talkAboutSeed(item: {
  title?: string | null
  hook?: string | null
  body?: string | null
}): string {
  return `I just read this and want to talk through it and build on it with you.\n\nTitle: ${item.title ?? 'Untitled'}\n${item.hook ? `Hook: ${item.hook}\n` : ''}\n--- CONTENT ---\n${item.body ?? ''}`
}
