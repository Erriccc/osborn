import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Per-site knowledge base — the agent's "digital profile" of each website.
 * Four layers per hostname under knowledge/<hostname>/:
 *
 *   actions.json — compiled UI actions (managed by step-cache; automatic)
 *   site.md      — learnings & findings the agent discovers (observations)
 *   rules.md     — RULES & REMINDERS the user teaches ("always leave the
 *                  room before exiting", "never click X during Y"). These
 *                  are binding: read them BEFORE operating on the site,
 *                  append when the user gives site-specific guidance.
 *   journeys/    — NAMED SEQUENCES that worked ("start-conversation" =
 *                  login → dashboard → new conversation), promoted from
 *                  directed sessions via the engine's /journey end. This is
 *                  how a deployment LEARNS a site's paths over time — each
 *                  install accumulates its own; they are not shipped.
 *
 * All plain files — shipped as skill accompanying files, no git required.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const KNOWLEDGE_DIR = process.env.OSBORN_KNOWLEDGE_DIR || join(__dirname, '..', 'knowledge')

export function siteDir(hostname: string): string {
  const dir = join(KNOWLEDGE_DIR, hostname)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readSiteRules(hostname: string): string {
  const f = join(siteDir(hostname), 'rules.md')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

export function addSiteRule(hostname: string, rule: string, source = 'user') {
  const f = join(siteDir(hostname), 'rules.md')
  if (!existsSync(f)) writeFileSync(f, `# ${hostname} — rules & reminders\n\nBinding guidance for any agent operating on this site. Read before acting; append when the user teaches something new.\n`)
  appendFileSync(f, `\n- ${rule} _(added ${new Date().toISOString().slice(0, 10)}, ${source})_\n`)
}

export function addSiteFinding(hostname: string, finding: string) {
  const f = join(siteDir(hostname), 'site.md')
  if (!existsSync(f)) writeFileSync(f, `# ${hostname} — agent site profile\n`)
  appendFileSync(f, `\n- ${finding} _(${new Date().toISOString().slice(0, 10)})_\n`)
}

/** Promote a proven step sequence into the site's journey library. */
export function saveJourney(hostname: string, name: string, journey: {
  goal?: string | null; startUrl: string; auth: string; savedAt: string
  steps: Array<{ kind: string; value: string }>
}): string {
  const dir = join(siteDir(hostname), 'journeys')
  mkdirSync(dir, { recursive: true })
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'journey'
  const f = join(dir, `${slug}.yaml`)
  const y = [
    `name: ${slug}`,
    journey.goal ? `goal: ${JSON.stringify(journey.goal)}` : null,
    `site: ${hostname}`,
    `startUrl: ${JSON.stringify(journey.startUrl)}`,
    'preconditions:',
    `  auth: ${journey.auth}`,
    `savedAt: ${journey.savedAt}`,
    'steps:',
    ...journey.steps.map((s) => `  - ${s.kind}: ${JSON.stringify(s.value)}`),
  ].filter(Boolean).join('\n')
  writeFileSync(f, y + '\n')
  return f
}

export function listJourneys(hostname: string): Array<{ name: string; goal: string | null; steps: number }> {
  const dir = join(siteDir(hostname), 'journeys')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => {
    const body = readFileSync(join(dir, f), 'utf8')
    return {
      name: f.replace(/\.yaml$/, ''),
      goal: body.match(/^goal: (.+)$/m)?.[1]?.replace(/^"|"$/g, '') ?? null,
      steps: (body.match(/^  - /gm) ?? []).length,
    }
  })
}
