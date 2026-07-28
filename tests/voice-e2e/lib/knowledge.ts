import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Per-site knowledge base — the agent's "digital profile" of each website.
 * Three layers per hostname under knowledge/<hostname>/:
 *
 *   actions.json — compiled UI actions (managed by step-cache; automatic)
 *   site.md      — learnings & findings the agent discovers (observations)
 *   rules.md     — RULES & REMINDERS the user teaches ("always leave the
 *                  room before exiting", "never click X during Y"). These
 *                  are binding: read them BEFORE operating on the site,
 *                  append when the user gives site-specific guidance.
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
