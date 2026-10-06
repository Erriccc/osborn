/**
 * lens-redact.ts — CLIENT/CUSTOMER redaction for the content lens.
 *
 * Content may draw on client work (ads-API lessons etc.) but never on who the
 * client is. Applied twice: (1) to every conversation row BEFORE it is sent to
 * the model (after the secret sanitizer), (2) to the final entry written to the
 * profile / sample file. Replacements are generic role tags ([client],
 * [founder], [ad account], [amount] …) so the technical lesson stays readable.
 *
 * Configurable, no names in source:
 *   - DEFAULT_PATTERNS below: shape-based (emails, act_…, platform IDs, UUIDs,
 *     phones, billing amounts).
 *   - <projectDir>/content-lens-denylist.json (or OSBORN_LENS_DENYLIST=<path>):
 *       { "terms":    { "[founder]": ["Name", ...], "[client]": [...], "[brand]": [...] },
 *         "patterns": [ { "re": "regex source", "flags": "gi", "replace": "[tag]" } ] }
 *     terms match whole words, case-insensitive (incl. possessive 's).
 *   Client company names are redacted BY DEFAULT (denylist "[client]" terms +
 *   any legal-suffixed company name). There is no per-project allowlist: the
 *   only override is the per-piece `reveal` option at draft/render time.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DENYLIST_FILE = 'content-lens-denylist.json'

export interface RedactRule {
  re: RegExp
  replace: string | ((m: string, ...a: any[]) => string)
}

const BILLING_WORDS = /\b(invoice[ds]?|invoicing|billing|billed|bill|retainer|payment|paid|refund(?:ed)?|deposit|owe[ds]?|payout|receivable|net[- ]?30)\b/i
const ID_CONTEXT =
  '(?:act_|ad[ _-]?account|account|customer|client[ _-]?customer|mcc|cid|business(?:[ _-]?manager)?|bm|page|ig|instagram|' +
  'pixel|dataset|catalog|app|sponsoredAccount|organization|campaign|adset|ad[ _-]?set|creative|login[ _-]?customer)'

/** Shape-based defaults. Order matters: specific shapes first. */
export const DEFAULT_PATTERNS: RedactRule[] = [
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: '[email]' },
  { re: /\bact_\d{5,}\b/g, replace: '[ad account]' },
  { re: /\burn:li:(?:sponsoredAccount|sponsoredCampaign|organization|person|company):[A-Za-z0-9_-]+/g, replace: '[linkedin account]' },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replace: '[workspace id]' },
  // Google Ads customer / MCC ids (123-456-7890) when an account word is nearby; otherwise a phone.
  {
    re: new RegExp(`(${ID_CONTEXT}[^\\n]{0,30}?)\\b\\d{3}-\\d{3}-\\d{4}\\b`, 'gi'),
    replace: (_m: string, pre: string) => `${pre}[ad account]`,
  },
  // Labelled platform ids: "page id 1234567890", "pixel: 123…", "IG 1784…", "customer_id=…".
  {
    re: new RegExp(`(${ID_CONTEXT}[\\s_-]*(?:id|ids|#|number)?["'\`]?\\s*[:=#]?\\s*["'\`]?)\\d{6,20}\\b`, 'gi'),
    replace: (_m: string, pre: string) => `${pre}[account id]`,
  },
  // Bare long numeric ids (Meta business/page/IG/pixel ids are 15-17 digits).
  { re: /(?<![\d.:-])\d{15,20}(?![\d.])/g, replace: '[account id]' },
  // Phone numbers: +country forms and (555) 555-5555 / 555-555-5555 / 555.555.5555.
  { re: /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g, replace: '[phone]' },
  { re: /(?<![\d-])\(?\b\d{3}\)?[\s.-]\d{3}[.-]\d{4}\b(?![\d-])/g, replace: '[phone]' },
]

/** $ amounts only on lines that talk about invoices/billing/payments (API pricing stays). */
function redactBillingAmounts(text: string): string {
  if (!BILLING_WORDS.test(text)) return text
  return text
    .split('\n')
    .map(line => (BILLING_WORDS.test(line) ? line.replace(/(?:US)?\$\s?\d[\d,]*(?:\.\d+)?(?:[kKmM]\b)?/g, '[amount]') : line))
    .join('\n')
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export interface ClientRedactor {
  rules: RedactRule[]
  terms: number
  source: string | null
  redact: (text: string) => string
}

function termRule(term: string, tag: string): RedactRule | null {
  const t = term.trim()
  if (t.length < 2) return null
  return { re: new RegExp(`(?<![A-Za-z0-9_])${escapeRe(t)}(?:'s|’s)?(?![A-Za-z0-9_])`, 'gi'), replace: tag }
}

export interface RedactorOptions {
  /**
   * PER-PIECE opt-in un-redaction: denylisted terms to leave visible for ONE
   * named draft/render (e.g. reveal: ["Audos"]). Never used by extraction —
   * the profile and samples are always stored fully redacted. A renderer that
   * reveals re-pulls the quote rows from session.db by row # and redacts them
   * with this option, in memory, for that piece only.
   */
  reveal?: string[]
}

/** Load the denylist (project dir or OSBORN_LENS_DENYLIST) + defaults. Never throws. */
export function loadClientRedactor(projectDir: string | null, opts: RedactorOptions = {}): ClientRedactor {
  const reveal = new Set((opts.reveal ?? []).map(s => s.trim().toLowerCase()).filter(Boolean))
  const rules: RedactRule[] = []
  let terms = 0
  let source: string | null = null
  const path = process.env.OSBORN_LENS_DENYLIST || (projectDir ? join(projectDir, DENYLIST_FILE) : '')
  if (path && existsSync(path)) {
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf-8'))
      source = path
      // Longest terms first so "Acme Labs" wins over "Acme".
      const pairs: [string, string][] = []
      for (const [tag, list] of Object.entries(cfg?.terms ?? {})) {
        if (!Array.isArray(list)) continue
        const label = /^\[.*\]$/.test(tag) ? tag : `[${tag}]`
        for (const term of list) if (typeof term === 'string') pairs.push([term, label])
      }
      pairs.sort((a, b) => b[0].length - a[0].length)
      for (const [term, label] of pairs) {
        if (reveal.has(term.trim().toLowerCase())) continue
        const r = termRule(term, label)
        if (r) {
          rules.push(r)
          terms++
        }
      }
      for (const p of Array.isArray(cfg?.patterns) ? cfg.patterns : []) {
        try {
          const flags = String(p?.flags ?? 'gi')
          rules.push({ re: new RegExp(String(p.re), flags.includes('g') ? flags : flags + 'g'), replace: String(p?.replace ?? '[redacted]') })
        } catch {
          /* skip a bad pattern, keep the rest */
        }
      }
    } catch {
      /* unreadable denylist → defaults only */
    }
  }
  rules.push(...DEFAULT_PATTERNS)
  // Default-on: legal-suffixed company names ("Acme Labs Inc", "Foo LLC") are clients
  // unless revealed for this piece. Named clients without a suffix live in the denylist.
  rules.push({
    re: /\b(?:[A-Z][A-Za-z0-9&'-]+\s){1,3}(?:Inc|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|GmbH|S\.A|SAS|BV|PLC|Pty)\b\.?/g,
    replace: (m: string) => (reveal.has(m.replace(/\s+(Inc|LLC|L\.L\.C|Ltd|Limited|Corp|Corporation|GmbH|S\.A|SAS|BV|PLC|Pty)\.?$/, '').trim().toLowerCase()) ? m : '[client]'),
  })
  const redact = (text: string): string => {
    let out = text
    for (const r of rules) out = out.replace(r.re, r.replace as any)
    return redactBillingAmounts(out)
  }
  return { rules, terms, source, redact }
}

/**
 * Billing gate. PERSONAL money talk is never content material; billing as an
 * ENGINEERING topic is.
 *   - BILLING_PERSONAL: always dropped, whatever the context: personal invoicing,
 *     retainers, refunds owed, overdue / unpaid / late fees, contract or rate
 *     negotiation, money owed to or by the user.
 *   - BILLING_AMBIGUOUS words (invoice, billing, payment, refund …): dropped UNLESS
 *     the same item carries technical context (BILLING_TECH): Stripe/payment
 *     webhook or API integration, billing API, payment gateway, ads-API billed
 *     spend / budget / spend caps / pricing, token pricing, rate limits, wallet holds.
 */
const BILLING_PERSONAL = new RegExp(
  [
    'retainers?',
    'accounts? receivable',
    'late fees?',
    'overdue',
    'unpaid',
    'past[- ]due',
    'outstanding (?:balance|invoices?|payments?)',
    'net[- ]?(?:15|30|45|60)\\b',
    'refunds? (?:owed|due)',
    '(?:owe[sd]?|owing) (?:me|us|you|him|her|them)\\b',
    '(?:i|we|they|he|she|you) (?:still )?owe\\b',
    'money (?:owed|due)',
    '(?:get|gets|getting|got) paid',
    '(?:pay|pays|paying|paid) (?:me|us)\\b(?! back)',
    "(?:hasn['’]t|haven['’]t|didn['’]t|never|not) (?:been )?paid",
    'send(?:s|ing)? (?:the |an |my |our |this )?invoices? to\\b',
    '(?:invoic\\w*|bill(?:ed|ing)?|charg(?:e|ed|ing)) (?:the |my |our |a |this |that |each )?clients?\\b',
    'invoic\\w* (?:them|him|her)\\b',
    'client (?:billing|invoices?|invoicing|payments?)\\b',
    '(?:hourly|day|daily|consulting|freelance|my|our) rates?\\b(?![- ]?limit)',
    'rate card',
    '(?:my|our|consulting|freelance) fees?\\b',
    'negotiat\\w* (?:the |my |our |a |their |his |her )?(?:rates?|contract|fees?|price|pricing|deal|retainer|terms|salary)\\b(?![- ]?limit)',
    '(?:rate|contract|fee|price|pricing|salary) negotiations?',
    'contract (?:rate|terms|renewal|value)',
    'statement of work',
  ].map(s => `\\b${s}`).join('|'),
  'i',
)
const BILLING_AMBIGUOUS = /\b(invoice[ds]?|invoicing|billing|billed|bill|payments?|paid|refunds?|refunded|chargebacks?|payouts?)\b/i
const BILLING_TECH = new RegExp(
  [
    'stripe', 'webhooks?', 'apis?', 'sdk', 'endpoints?', 'gateway', 'integrations?', 'idempoten\\w*',
    'spend(?: caps?)?', 'spending limits?', 'budgets?', 'pricing', 'per[- ]million', 'tokens?', 'rate[- ]limit\\w*',
    'quotas?', 'wallets?', 'meta ads', 'google ads', 'linkedin ads', 'ads? accounts?', 'campaigns?',
    'openrouter', 'schema', 'migrations?', 'cron', 'queues?',
  ].map(s => `\\b${s}\\b`).join('|'),
  'i',
)

/** True for personal billing talk; ambiguous billing words pass only with technical context (in `text` or `context`). */
export function isBillingText(text: string, context = ''): boolean {
  if (BILLING_PERSONAL.test(text)) return true
  return BILLING_AMBIGUOUS.test(text) && !BILLING_TECH.test(`${text} ${context}`)
}

export const isBillingAngle = (a: { title: string; why: string }): boolean => isBillingText(`${a.title} ${a.why}`)
/** Same billing gate for capabilities: name, did and proof. */
export const isBillingCapability = (c: { name: string; did: string; proof: string }): boolean =>
  isBillingText(`${c.name} ${c.did} ${c.proof}`)
/** True when any (verified) quote's text talks billing (the item's own fields count as technical context). */
export const hasBillingQuote = (it: { quotes: unknown[] }): boolean => {
  if (!Array.isArray(it.quotes)) return false
  const o = it as Record<string, unknown>
  const ctx = ['title', 'why', 'name', 'did', 'proof'].map(k => (typeof o[k] === 'string' ? o[k] : '')).join(' ')
  return it.quotes.some(q => typeof (q as any)?.text === 'string' && isBillingText((q as any).text, ctx))
}
