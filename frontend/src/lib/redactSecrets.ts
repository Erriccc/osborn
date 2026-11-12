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
export function redactSecrets(s: string | undefined | null): string {
  if (!s) return s ?? ''
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, 'sk-ant-••••')
    .replace(/sk-or-[A-Za-z0-9_-]{6,}/g, 'sk-or-••••')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-••••')
    .replace(/sbp_[A-Za-z0-9]{10,}/g, 'sbp_••••')
    .replace(/ghp_[A-Za-z0-9]{10,}/g, 'ghp_••••')
    .replace(/eyJ[A-Za-z0-9._-]{18,}\.[A-Za-z0-9._-]{10,}/g, 'eyJ••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1••••')
    .replace(/((?:[A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY))["'\s]*[=:]\s*["']?)([^\s"']{6,})/gi, '$1••••')
}
