// Synthetic recall fixture (#681): invented sessions, no real transcripts. Project A is the active
// project, B another one whose rows sit in the same store (a resumed or dispatched session).
export type Project = 'A' | 'B'
export interface Msg { key: string; project: Project; source: 'main' | 'agent'; role: 'user' | 'assistant'; text: string; afterCompaction?: boolean }
export type Kind = 'recent' | 'precompact' | 'decision' | 'path' | 'number' | 'name' | 'error' | 'subagent' | 'other-project'
export interface Question { q: string; expect: string; kind: Kind }

const m = (key: string, project: Project, role: Msg['role'], text: string, extra: Partial<Msg> = {}): Msg =>
  ({ key, project, source: 'main', role, text, ...extra })

export const CORPUS: Msg[] = [
  // before the compaction
  m('dec-queue', 'A', 'assistant', 'We decided to use a BullMQ queue for the invoice exports instead of cron, because retries are built in.'),
  m('path-retry', 'A', 'assistant', 'The retry policy lives in src/billing/retryPolicy.ts and exports backoffSchedule.'),
  m('num-pool', 'A', 'user', 'Set the database pool to 37 connections for the staging cluster.'),
  m('name-vendor', 'A', 'user', 'The payment vendor we picked is Larkspur Pay, contract signed by Mirelle Tanaka.'),
  m('err-econn', 'A', 'assistant', 'The export job failed with ERR_STREAM_PREMATURE_CLOSE when the S3 upload exceeded the 90 second socket timeout.'),
  m('dec-flag', 'A', 'user', 'Ship the new onboarding flow behind the flag onboarding_v3 and keep it off for enterprise accounts.'),
  m('path-migr', 'A', 'assistant', 'The migration adding the tenant_region column is db/migrations/0042_tenant_region.sql.'),
  m('num-latency', 'A', 'assistant', 'The p95 latency of the search endpoint dropped from 840ms to 212ms after the index change.'),
  m('name-cluster', 'A', 'user', 'Name the staging cluster heron-east and the production one osprey-west.'),
  m('err-tsc', 'A', 'assistant', 'tsc reported TS2345 in webhookSigner.ts: argument of type Buffer is not assignable to parameter of type string.'),
  m('dec-auth', 'A', 'assistant', 'Decision: sessions use opaque tokens stored in Redis, not JWTs, so we can revoke them instantly.'),
  m('path-dash', 'A', 'user', 'The dashboard chart component is frontend/src/components/RevenueSparkline.tsx.'),
  { key: 'compaction', project: 'A', source: 'main', role: 'user', text: 'Summary of earlier work: billing exports, onboarding flag and the auth decision were covered.', afterCompaction: true },
  // after the compaction
  m('rec-timeout', 'A', 'assistant', 'I raised the upload socket timeout to 240 seconds in the exporter config.', { afterCompaction: true }),
  m('rec-canary', 'A', 'user', 'Run the canary on the quokka-3 shard first, then roll out to the rest.', { afterCompaction: true }),
  m('rec-file', 'A', 'assistant', 'The canary runner is scripts/canaryRollout.mjs and it reads shards.json.', { afterCompaction: true }),
  m('rec-num', 'A', 'user', 'Cap the webhook batch size at 128 events per request.', { afterCompaction: true }),
  m('rec-dec', 'A', 'assistant', 'We agreed to drop the legacy CSV importer once the Parquet path covers every tenant.', { afterCompaction: true }),
  m('rec-err', 'A', 'assistant', 'The test suite failed with SQLITE_CONSTRAINT_UNIQUE on the idempotency_keys table.', { afterCompaction: true }),
  m('rec-name', 'A', 'user', 'The on-call rotation is called nightjar and Corwin Abara is primary this week.', { afterCompaction: true }),
  // sub-agent results
  { key: 'sub-leak', project: 'A', source: 'agent', role: 'assistant', text: 'Researcher found the memory leak in the websocket gateway: listeners registered in reconnectHandler.ts were never removed.' },
  { key: 'sub-lib', project: 'A', source: 'agent', role: 'assistant', text: 'Comparison result: the library undici handled 9400 requests per second versus 6100 for node-fetch in the benchmark.' },
  { key: 'sub-cve', project: 'A', source: 'agent', role: 'assistant', text: 'Reviewer flagged an unescaped template in emails/receipt.hbs that allows markup injection.' },
  // another project
  m('b-secret', 'B', 'assistant', 'The Meridian project uses the passphrase glacier-orchid-77 for its signing keystore.'),
  m('b-dec', 'B', 'user', 'For the Meridian mobile app we decided on Expo Router instead of React Navigation.'),
  m('b-path', 'B', 'assistant', 'Meridian push notification setup is in apps/mobile/notifications/registerDevice.ts.'),
  m('b-num', 'B', 'assistant', 'The Meridian crash-free rate reached 99.2 percent after the splash screen fix.'),
]

export const QUESTIONS: Question[] = [
  { q: 'what did we decide about the invoice export queue instead of cron', expect: 'dec-queue', kind: 'precompact' },
  { q: 'which file holds the retry policy backoffSchedule', expect: 'path-retry', kind: 'precompact' },
  { q: 'how many connections for the database pool on staging', expect: 'num-pool', kind: 'precompact' },
  { q: 'who signed the contract with the payment vendor', expect: 'name-vendor', kind: 'precompact' },
  { q: 'why did the export job fail with the S3 upload socket timeout', expect: 'err-econn', kind: 'precompact' },
  { q: 'which flag gates the new onboarding flow for enterprise', expect: 'dec-flag', kind: 'decision' },
  { q: 'which migration added the tenant_region column', expect: 'path-migr', kind: 'path' },
  { q: 'p95 latency of the search endpoint after the index change', expect: 'num-latency', kind: 'number' },
  { q: 'what are the staging and production clusters named', expect: 'name-cluster', kind: 'name' },
  { q: 'what was the TS2345 error in webhookSigner', expect: 'err-tsc', kind: 'error' },
  { q: 'why opaque tokens in Redis instead of JWT for sessions', expect: 'dec-auth', kind: 'decision' },
  { q: 'where is the revenue chart component', expect: 'path-dash', kind: 'path' },
  { q: 'what timeout did we raise for the upload socket', expect: 'rec-timeout', kind: 'recent' },
  { q: 'which shard does the canary run on first', expect: 'rec-canary', kind: 'recent' },
  { q: 'which script runs the canary rollout and what does it read', expect: 'rec-file', kind: 'recent' },
  { q: 'what is the cap on webhook batch size', expect: 'rec-num', kind: 'recent' },
  { q: 'when do we drop the legacy CSV importer', expect: 'rec-dec', kind: 'recent' },
  { q: 'which unique constraint failed on idempotency_keys in the tests', expect: 'rec-err', kind: 'recent' },
  { q: 'who is primary on call and what is the rotation called', expect: 'rec-name', kind: 'recent' },
  { q: 'where was the websocket gateway memory leak', expect: 'sub-leak', kind: 'subagent' },
  { q: 'how did undici compare with node-fetch in the benchmark', expect: 'sub-lib', kind: 'subagent' },
  { q: 'what did the reviewer flag in the receipt email template', expect: 'sub-cve', kind: 'subagent' },
  { q: 'passphrase for the Meridian signing keystore', expect: 'b-secret', kind: 'other-project' },
  { q: 'what navigation library did the Meridian mobile app choose', expect: 'b-dec', kind: 'other-project' },
  { q: 'where is Meridian push notification device registration', expect: 'b-path', kind: 'other-project' },
  { q: 'Meridian crash-free rate after the splash screen fix', expect: 'b-num', kind: 'other-project' },
]
