/**
 * content-refine — platform system prompts + model-output parsing for the
 * content refine studio (POST /api/content/refine).
 *
 * The studio turns a raw library item (internal notes written by the
 * content-lens worker) into a polished, platform-specific, SEO-friendly
 * rendition via a fast LLM (Fireworks gpt-oss-120b). Each platform has its own
 * system prompt; all of them ask the model to return STRICT JSON with the same
 * shape so the route can persist it uniformly.
 */

export const PLATFORMS = ['blog', 'x_thread', 'linkedin', 'short', 'newsletter'] as const
export type Platform = (typeof PLATFORMS)[number]

export function isPlatform(v: unknown): v is Platform {
  return typeof v === 'string' && (PLATFORMS as readonly string[]).includes(v)
}

/** Human labels for the UI chips. */
export const PLATFORM_LABELS: Record<Platform, string> = {
  blog: 'Blog',
  x_thread: 'X thread',
  linkedin: 'LinkedIn',
  short: 'Short',
  newsletter: 'Newsletter',
}

/** The parsed, normalized model output the route persists. */
export interface RefineResult {
  title: string
  hook: string
  body: string
  seo: { metaTitle: string; metaDescription: string }
}

// Shared tone + JSON contract appended to every platform brief. Tone:
// confident, enterprise-credible, not hypey.
const COMMON = `
The SOURCE is raw internal notes — extract the real story and drop logs, row numbers, verification noise, and any machine-generated bookkeeping. Write for a human reader.
Tone: confident and enterprise-credible, never hypey or buzzword-laden. No emojis unless the platform brief calls for them.
Return STRICT JSON and nothing else — no prose, no markdown fences, no commentary. The JSON object must have exactly these keys:
{"title": string, "hook": string, "body": string, "metaTitle": string, "metaDescription": string}
"metaTitle" must be <= 60 characters and "metaDescription" <= 155 characters, both SEO-friendly. "hook" is a one- or two-sentence opening line.`

const PLATFORM_BRIEFS: Record<Platform, string> = {
  blog: `You are a content editor. Rewrite the SOURCE into a long-form, SEO-optimized BLOG post.
Structure the body with clear H2 section headings (use markdown "## Heading"). Open with a strong lede, develop 3-5 sections, and close with a takeaway. Aim for depth and scannability.`,

  x_thread: `You are a content editor. Rewrite the SOURCE into an X (Twitter) THREAD.
The body must be a numbered thread (1/, 2/, 3/ ...). Each tweet must be <= 270 characters. Lead with the single strongest hook tweet. Keep each tweet self-contained and punchy. End with a light call to action.`,

  linkedin: `You are a content editor. Rewrite the SOURCE into a professional LINKEDIN post.
Use short, scannable paragraphs with generous line breaks. Open with a compelling first line (it is the preview). Keep it credible and insight-led. Include exactly ONE clear call to action at the end.`,

  short: `You are a content editor. Rewrite the SOURCE into a SHORT-form video script.
The body must be a punchy hook line followed by a tight 3-5 line spoken script. Front-load the payoff. Keep lines short enough to say in one breath.`,

  newsletter: `You are a content editor. Rewrite the SOURCE into a NEWSLETTER.
Begin the body with a "Subject: ..." line (this is the email subject), then the newsletter body in a warm but professional voice. Lead with the single most useful insight.`,
}

/** Build the system prompt for a platform. */
export function systemPrompt(platform: Platform): string {
  return `${PLATFORM_BRIEFS[platform]}\n${COMMON}`
}

/**
 * Build the user message: the source body, plus an optional iterative-refine
 * instruction (e.g. "make it punchier", "target enterprise CTOs").
 */
export function userPrompt(sourceBody: string, instruction?: string, sourceTitle?: string | null): string {
  const parts: string[] = []
  if (sourceTitle) parts.push(`SOURCE TITLE: ${sourceTitle}`)
  parts.push('SOURCE:\n' + (sourceBody || '(empty)'))
  if (instruction && instruction.trim()) {
    parts.push(
      `\nREFINEMENT INSTRUCTION: ${instruction.trim()}\nApply this instruction to your rewrite. Keep the same JSON contract.`,
    )
  }
  return parts.join('\n\n')
}

/**
 * Defensively parse the model's output into a RefineResult.
 * The prompt asks for strict JSON, but models sometimes wrap it in prose or
 * markdown fences — so we extract the first balanced {...} block and parse that.
 * Throws if no usable JSON object can be recovered.
 */
export function parseModelOutput(raw: string): RefineResult {
  const obj = extractJsonObject(raw)
  if (!obj) throw new Error('Model did not return a JSON object')

  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

  const title = str(obj.title).trim()
  const hook = str(obj.hook).trim()
  const body = str(obj.body).trim()
  let metaTitle = str(obj.metaTitle).trim()
  let metaDescription = str(obj.metaDescription).trim()

  // Sensible fallbacks + SEO length clamps so we never persist junk.
  if (!metaTitle) metaTitle = title
  if (!metaDescription) metaDescription = hook
  metaTitle = metaTitle.slice(0, 60)
  metaDescription = metaDescription.slice(0, 155)

  if (!body) throw new Error('Model returned an empty body')

  return { title, hook, body, seo: { metaTitle, metaDescription } }
}

/**
 * Extract the first balanced top-level JSON object from a string and parse it.
 * Handles leading/trailing prose and ```json fences by scanning for the first
 * '{' and matching braces (string-aware so braces inside strings don't fool it).
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  // Fast path: the whole thing is already JSON.
  const trimmed = raw.trim()
  try {
    const direct = JSON.parse(trimmed)
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return direct as Record<string, unknown>
    }
  } catch {
    // fall through to brace scanning
  }

  const start = raw.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>
          }
        } catch {
          return null
        }
        return null
      }
    }
  }
  return null
}
