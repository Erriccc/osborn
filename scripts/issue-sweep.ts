// Report-only issue sweep (docs/issue-flow.md). Reads GitHub, writes nothing there.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { terms } from '../agent/src/stopwords.js'
import { FOLLOW_THROUGH_LABEL, REPO } from '../frontend/src/lib/github-issue-mirror.js'

const DAY = 864e5
const CLAIM = /^claim:\s+(\S+)\s+(\S+)\s+(\S+?)[.,;]*[ \t]*$/m
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Issue numbers a text refers to: `#N` only, not hex colours (`#1e293b`) or other-repo refs (`owner/repo#10`). */
export const refs = (text: string): number[] => [...text.matchAll(/(?<![\w/])#(\d+)\b/g)].map((m) => +m[1])

/** Latest-claim line parser. ms is NaN when the expiry is not a full ISO time with Z or an offset. */
export function parseClaim(body: string) {
  const m = CLAIM.exec(body ?? '')
  if (!m) return null
  return { agent: m[1], expiry: m[3], ms: ISO.test(m[3]) ? Date.parse(m[3]) : NaN }
}

const shared = (a, b) => {
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return n
}
const jaccard = (a, b) => {
  const n = shared(a, b)
  return a.size + b.size - n ? n / (a.size + b.size - n) : 0
}
const labelNames = (i) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))
const claimed = (i) => labelNames(i).includes('q:claimed')

/** issues: open issues (no PRs); prs: merged PRs {number,title,body}; comments: {[issue#]: [{body,created_at}]}; branches: branch names */
export function sweep({ issues, prs, openPrs = [] as any[], branches = [] as string[], comments = {}, config = {} as { parked?: number[]; founderDecision?: number[] }, now = Date.now(), dupThreshold = 0.5 }) {
  const skip = new Set([...(config.parked ?? []), ...(config.founderDecision ?? [])])
  const open = issues.filter((i) => !skip.has(i.number))
  const age = (i) => (now - Date.parse(i.created_at)) / DAY
  const idle = (i) => (now - Date.parse(i.updated_at)) / DAY
  const pick = (f) => open.filter(f).map((i) => i.number)
  const buckets = { 'under 2d': 0, '2-7d': 0, '7-30d': 0, 'over 30d': 0 }
  for (const i of open) buckets[age(i) < 2 ? 'under 2d' : age(i) < 7 ? '2-7d' : age(i) < 30 ? '7-30d' : 'over 30d']++
  const mentioned = new Map()
  for (const p of prs) for (const n of refs(`${p.title} ${p.body ?? ''}`)) {
    if (n !== p.number && !mentioned.has(n)) mentioned.set(n, p.number)
  }
  const refd = new Set(mentioned.keys())
  const openRef = new Set<number>()
  for (const p of openPrs) for (const n of refs(`${p.title} ${p.body ?? ''}`)) if (n !== p.number) openRef.add(n)
  const note = (i) => labelNames(i).includes(FOLLOW_THROUGH_LABEL)
  // The autopilot network claims with the label plus an auto/<n>-* branch or an open PR, no comment.
  const inFlight = new Set(openRef)
  for (const b of branches) { const m = /^auto\/(\d+)-/.exec(b); if (m) inFlight.add(+m[1]) }
  const expiredClaims = []
  for (const i of open.filter(claimed)) {
    const last = [...(comments[i.number] ?? [])].reverse().map((c) => parseClaim(c.body)).find(Boolean)
    if (!last) { if (!inFlight.has(i.number)) expiredClaims.push({ number: i.number, reason: 'no claim comment' }) }
    else if (Number.isNaN(last.ms)) expiredClaims.push({ number: i.number, agent: last.agent, reason: 'bad expiry' })
    else if (last.ms < now && !inFlight.has(i.number)) expiredClaims.push({ number: i.number, agent: last.agent, expiry: last.expiry })
  }
  const tt = open.map((i) => ({ n: i.number, t: terms(i.title) }))
  const duplicates = []
  for (let a = 0; a < tt.length; a++) for (let b = a + 1; b < tt.length; b++)
    if (shared(tt[a].t, tt[b].t) >= 2 && jaccard(tt[a].t, tt[b].t) >= dupThreshold) duplicates.push([tt[a].n, tt[b].n])
  return {
    total: open.length,
    excluded: issues.length - open.length,
    expiredClaims,
    closeCandidates: pick((i) => refd.has(i.number)).map((n) => ({ number: n, pr: mentioned.get(n) })),
    unclaimed: pick((i) => !note(i) && !claimed(i) && !openRef.has(i.number)),
    claimable: pick((i) => !note(i) && !claimed(i) && !openRef.has(i.number) && age(i) > 1),
    stale7d: pick((i) => !note(i) && idle(i) >= 7),
    unlabelled: pick((i) => !labelNames(i).length),
    duplicates,
    buckets,
  }
}

export function render(r) {
  const list = (a) => (a.length ? a.map((n) => `#${n}`).join(' ') : 'none')
  return [
    `# Issue sweep (${r.total} open, ${r.excluded} parked or awaiting founder decision, excluded)`,
    `## Expired claims\n${r.expiredClaims.length ? r.expiredClaims.map((c) => `- #${c.number} ${c.agent ?? ''} ${c.expiry ?? c.reason}`).join('\n') : 'none'}`,
    `## Open but mentioned by a merged PR (candidates to close, not closed)\n${r.closeCandidates.length ? r.closeCandidates.map((c) => `- #${c.number} (PR #${c.pr})`).join('\n') : 'none'}`,
    `## Likely duplicates\n${r.duplicates.length ? r.duplicates.map((g) => `- ${list(g)}`).join('\n') : 'none'}`,
    `## Unclaimed (no q:claimed label, no open PR mentions it)\n${list(r.unclaimed)}`,
    `## Claimable by the hourly loop and Muse (no q:claimed label, open over 24h)\n${list(r.claimable)}`,
    `## Stale 7d+\n${list(r.stale7d)}`,
    `## No label\n${list(r.unlabelled)}`,
    `## By age\n${Object.entries(r.buckets).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
  ].join('\n\n')
}

const gh = (path) => {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return JSON.parse(out).flat()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(new URL('../docs/issue-sweep-config.json', import.meta.url), 'utf8'))
  const issues = gh(`repos/${REPO}/issues?state=open&per_page=100`).filter((i) => !i.pull_request)
  const closedPrs = gh(`repos/${REPO}/pulls?state=closed&per_page=100`)
  const prs = closedPrs.filter((p) => p.merged_at)
  const openPrs = gh(`repos/${REPO}/pulls?state=open&per_page=100`)
  // A branch whose PR is closed or merged is no longer a claim (the repo does not delete branches on merge).
  const done = new Set(closedPrs.map((p) => p.head?.ref))
  const branches = gh(`repos/${REPO}/branches?per_page=100`).map((b) => b.name).filter((n) => !done.has(n))
  const comments = {}
  for (const i of issues.filter((x) => x.comments && claimed(x)))
    comments[i.number] = gh(`repos/${REPO}/issues/${i.number}/comments?per_page=100`)
  const r = sweep({ issues, prs, openPrs, branches, comments, config })
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r))
}
