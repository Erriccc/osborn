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
// These are a SUBSET of the rule shapes in the agent-side sanitizer
// (agent/src/content/transcript-sanitizer.ts SECRET_RULES), re-typed because that
// module imports node:fs and cannot be pulled into the client — the same reason
// src/lib/transcript-clean.ts ports its cleaner instead of importing it. Vendors
// it does NOT cover yet: npm_, AIza, xox*, AKIA, fw_, snx_, PEM blocks. The
// durable fix is to lift the agent's rule array into a dependency-free module
// both packages import, rather than growing a second copy here.
//
// RULE FOR EDITORS: the floors here are deliberately at or BELOW the agent's and
// must never be raised. All a higher floor buys is prose that reads slightly
// better; what it costs is a short real credential printed in full (a LiveKit key
// is "API" + ~12 chars). Over-masking a sentence is the cheap loss; under-masking
// a credential is not. Where prose does need sparing, change the SHAPE of a rule
// — Bearer wants a 20-char value because "uses Bearer formatting" is ordinary
// English — never the floor, and never at the price of a separator: dropping the
// ":" from the assignment rule once un-masked every `NAME_SECRET: value` block.
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
    // "=" OR ":" — a .env line and a YAML/JSON block are both common in results.
    // This over-masks a sentence like "TOKEN: expired, re-run …"; that is the
    // intended trade, since narrowing it to "=" leaks every colon-form block.
    .replace(/\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|ACCESS[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|TOKEN))(\s*[=:]\s*)(["']?)([^\s"']{6,})\3/gi, '$1$2$3••••$3')
}
