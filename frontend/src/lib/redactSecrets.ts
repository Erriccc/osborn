// redactSecrets — the Activity log's single secret-masking gate.
//
// Mask secret-looking substrings before anything reaches the UI or the clipboard.
// A tool command, an ingest script or a SUB-AGENT RESULT can embed a token
// (provider API key, Bearer, Supabase PAT, GitHub PAT, JWT, or a sensitive env
// assignment); the Activity log must never surface it. (Audit §16 flagged a
// credential-like string shown inside a temporary ingest script.)
//
// It lives here, not inside a component, so every surface that renders or stores
// agent-authored text can apply the same invariant — and so it is unit-testable
// (see frontend/tests/activity-redaction.test.ts).
//
// Rules mirror the agent-side sanitizer, which is this repo's mature secret
// filter (agent/src/content/transcript-sanitizer.ts SECRET_RULES, covered by its
// own verify-sanitizer). Ported rather than imported — src/lib/transcript-clean.ts
// ports the same module's cleaner for the same reason: the agent package is
// server-side and reaches for node:fs.
//
// Keep each floor at the agent's value and never raise one on your own: the only
// thing a higher floor buys is prose that reads slightly better, and what it
// costs is a short real credential printed in full. The one deliberate narrowing
// is Bearer at 20, the agent's own value, because the old floor of 8 masked the
// word after "Bearer" in ordinary prose ("uses Bearer formatting now").
// The generic assignment rule requires "=", again as the agent has it, so a
// sentence like "TOKEN: expired, re-run the login flow" survives; colon-form
// headers are covered by the api-key and Authorization rules instead.
export function redactSecrets(s: string | undefined | null): string {
  if (!s) return s ?? ''
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, 'sk-ant-••••')
    .replace(/sk-or-[A-Za-z0-9_-]{6,}/g, 'sk-or-••••')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-••••')
    .replace(/sbp_[A-Za-z0-9]{10,}/g, 'sbp_••••')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}/g, 'gh_••••')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'gh_••••')
    // Fly macaroons: a real token is a comma-separated list of fm1_/fm2_
    // segments, so redact the whole list, not just the first segment.
    .replace(/FlyV1\s+fm[12]_[A-Za-z0-9/+_=-]+(?:\s*,\s*fm[12]_[A-Za-z0-9/+_=-]+)*/g, 'FlyV1 ••••')
    .replace(/(?<![A-Za-z0-9])(?:fm[12]|fo1)_[A-Za-z0-9/+_=-]{20,}/g, 'fly_••••')
    // Two segments are enough: a truncated JWT is still a credential, and the
    // old 18-char floor on the header missed a short one.
    .replace(/eyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}/g, 'eyJ••••')
    .replace(/(\b(?:x-goog-|x-)?api-key["'`]?\s*[:=]\s*["'`]?)(?!\$)[^\s"'`,;}]{8,}/gi, '$1••••')
    .replace(/(Authorization["'`]?\s*:\s*["'`]?(?:(?:Bearer|Basic|Token)\s+)?)(?!\$)[^\s"'`,;}]{8,}/gi, '$1••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{20,}/gi, '$1••••')
    .replace(/\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|ACCESS[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|TOKEN))(\s*=\s*)(["']?)([^\s"']{6,})\3/gi, '$1$2$3••••$3')
}
