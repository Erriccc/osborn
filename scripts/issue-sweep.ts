// Report-only issue sweep (docs/issue-flow.md). Reads GitHub, writes nothing there.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { terms } from '../agent/src/stopwords.js'

const DAY = 864e5
const CLAIM = /^claim:\s+(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2}T\S+)/m

const jaccard = (a, b) => {
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return a.size + b.size - n ? n / (a.size + b.size - n) : 0
}
const labelNames = (i) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name))

/** issues: open issues (no PRs); prs: merged PRs {number,title,body}; comments: {[issue#]: [{body,created_at}]} */
export function sweep({ issues, prs, comments = {}, config = {} as { parked?: number[]; founderDecision?: number[] }, now = Date.now(), dupThreshold = 0.5 }) {
  const skip = new Set([...(config.parked ?? []), ...(config.founderDecision ?? [])])
  const open = issues.filter((i) => !skip.has(i.number))
  const age = (i) => (now - Date.parse(i.created_at)) / DAY
  const idle = (i) => (now - Date.parse(i.updated_at)) / DAY
  const pick = (f) => open.filter(f).map((i) => i.number)
  const buckets = { 'under 2d': 0, '2-7d': 0, '7-30d': 0, 'over 30d': 0 }
  for (const i of open) buckets[age(i) < 2 ? 'under 2d' : age(i) < 7 ? '2-7d' : age(i) < 30 ? '7-30d' : 'over 30d']++
  const mentioned = new Map()
  for (const p of prs) for (const m of `${p.title} ${p.body ?? ''}`.matchAll(/#(\d+)/g)) {
    const n = +m[1]
    if (n !== p.number && !mentioned.has(n)) mentioned.set(n, p.number)
  }
  const refd = new Set(mentioned.keys())
  const expiredClaims = []
  for (const i of open.filter((x) => labelNames(x).includes('q:claimed'))) {
    const last = [...(comments[i.number] ?? [])].reverse().map((c) => CLAIM.exec(c.body ?? '')).find(Boolean)
    if (!last) expiredClaims.push({ number: i.number, reason: 'no claim comment' })
    else if (Date.parse(last[3]) < now) expiredClaims.push({ number: i.number, agent: last[1], expiry: last[3] })
  }
  const tt = open.map((i) => ({ n: i.number, t: terms(i.title) }))
  const parent = new Map(tt.map((x) => [x.n, x.n]))
  const find = (n) => (parent.get(n) === n ? n : find(parent.get(n)))
  for (let a = 0; a < tt.length; a++) for (let b = a + 1; b < tt.length; b++)
    if (jaccard(tt[a].t, tt[b].t) >= dupThreshold) parent.set(find(tt[b].n), find(tt[a].n))
  const groups = new Map()
  for (const { n } of tt) groups.set(find(n), [...(groups.get(find(n)) ?? []), n])
  return {
    total: open.length,
    excluded: issues.length - open.length,
    expiredClaims,
    closeCandidates: pick((i) => refd.has(i.number)).map((n) => ({ number: n, pr: mentioned.get(n) })),
    unclaimed: pick((i) => !i.comments && !refd.has(i.number) && !labelNames(i).includes('q:claimed')),
    stale7d: pick((i) => idle(i) >= 7),
    unlabelled: pick((i) => !labelNames(i).length),
    duplicates: [...groups.values()].filter((g) => g.length > 1),
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
    `## Unclaimed (no comment, no PR)\n${list(r.unclaimed)}`,
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
  const repo = process.env.OSBORN_REPO || 'Erriccc/osborn'
  const config = JSON.parse(readFileSync(new URL('../docs/issue-sweep-config.json', import.meta.url), 'utf8'))
  const issues = gh(`repos/${repo}/issues?state=open&per_page=100`).filter((i) => !i.pull_request)
  const prs = gh(`repos/${repo}/pulls?state=closed&per_page=100`).filter((p) => p.merged_at)
  const comments = {}
  for (const i of issues.filter((x) => x.comments && (x.labels ?? []).some((l) => l.name === 'q:claimed')))
    comments[i.number] = gh(`repos/${repo}/issues/${i.number}/comments?per_page=100`)
  const r = sweep({ issues, prs, comments, config })
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r))
}
