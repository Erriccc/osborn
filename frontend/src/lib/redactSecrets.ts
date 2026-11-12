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
// The length floors are ported from the agent-side sanitizer that already settled
// them (agent/src/content/transcript-sanitizer.ts SECRET_PATTERNS). Every body in
// this drawer is now free prose as well as commands, and the old 6-10 char floors
// false-fired on prose: "Bearer formatting" became "Bearer ••••" and
// "TOKEN: expired, re-run" ate the word and the comma. A real credential clears
// 20 characters; an English word next to the prefix does not. Ported rather than
// imported, as src/lib/transcript-clean.ts ports the same module's cleaner —
// the agent package is server-side.
export function redactSecrets(s: string | undefined | null): string {
  if (!s) return s ?? ''
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-••••')
    .replace(/sk-or-[A-Za-z0-9_-]{20,}/g, 'sk-or-••••')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-••••')
    .replace(/sbp_[A-Za-z0-9]{20,}/g, 'sbp_••••')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'gh_••••')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{20,}/gi, '$1••••')
    .replace(/((?:[A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY))["'\s]*[=:]\s*["']?)([^\s"']{20,})/gi, '$1••••')
}
