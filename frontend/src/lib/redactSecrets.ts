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
// Rules overlap the agent-side sanitizer's (agent/src/content/transcript-sanitizer
// .ts SECRET_RULES) but are not identical; re-typed because that module imports
// node:fs. Still unmasked on their own here: npm_, AIza, xox*, AKIA, fw_, snx_,
// PEM. The durable fix is to split that file's pure rule array into an fs-free
// module both packages import instead of re-typing it a third time.
//
// RULES FOR EDITORS, each learned from a shipped bug:
//  - Never raise a floor to make text read better. A LiveKit key is "API" + ~12
//    chars, so a floor tuned to long values prints short real credentials.
//  - Never drop a separator, and keep them quote-tolerant. `"MY_TOKEN": "…"` from
//    a JSON or `fly secrets` block is as common as a bare .env line, and a
//    separator that cannot cross the name's closing quote leaks all of them.
//  - Do not require a CLOSING quote either: drawer bodies are truncated mid-
//    string, and `MY_TOKEN: "abc…` must still mask.
//  - Narrow by SHAPE instead. The three rules that take a free-form value guard
//    with `(?!\$)` (a `$VAR` reference is not a secret) and
//    `(?![A-Za-z]{1,11}(?![\w+/=-]))` (one short word — `string`, `number`,
//    `expired`, `header` — is a type annotation, a diff line or a sentence, not
//    a credential). The inner class is what makes the guard safe: with a plain
//    `\b` it also skipped `sk-proj-…`, `xoxb-…` and `glpat-…`, because `\b`
//    fires before a hyphen. Do not add `.` to it — that re-masks
//    `docs/api-key: rotation.md`.
export function redactSecrets(s: string | undefined | null): string {
  if (!s) return s ?? ''
  return s
    .replace(/(?<![A-Za-z0-9])sk-(?:ant|or)-[A-Za-z0-9_-]{6,}/g, 'sk-••••')
    .replace(/\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/g, 'sk-••••')
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/g, 'sk-••••')
    .replace(/sbp_[A-Za-z0-9]{10,}/g, 'sbp_••••')
    // Two rules at the agent's floor of 30, not one folded rule: folding them
    // lets the `_` the fine-grained class needs match an identifier like
    // `ghs_installation_cache`, and stops a real github_pat_ body at its first
    // underscore so the tail still prints.
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'gh_••••')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{30,}/g, 'gh_••••')
    // A real Fly macaroon is a comma-separated list of segments; redact the
    // whole list, not just the first one.
    .replace(/FlyV1\s+fm[12]_[A-Za-z0-9/+_=-]+(?:\s*,\s*fm[12]_[A-Za-z0-9/+_=-]+)*/g, 'FlyV1 ••••')
    .replace(/(?<![A-Za-z0-9])(?:fm[12]|fo1)_[A-Za-z0-9/+_=-]{20,}/g, 'fly_••••')
    // Two segments, short header: a truncated JWT is still a credential.
    .replace(/eyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}/g, 'eyJ••••')
    .replace(/(\b(?:x-goog-|x-)?api-key["'`]?\s*[:=]\s*["'`]?)(?!\$)(?![A-Za-z]{1,11}(?![\w+/=-]))[^\s"'`,;}]{8,}/gi, '$1••••')
    .replace(/(Authorization["'`]?\s*:\s*["'`]?(?:(?:Bearer|Basic|Token)\s+)?)(?!\$)(?![A-Za-z]{1,11}(?![\w+/=-]))[^\s"'`,;}]{8,}/gi, '$1••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{20,}/gi, '$1••••')
    // The last guard spares a TS/Python type annotation (`token: AccessTokenPayload
    // = decode(raw)`), which only the assignment rule can run into.
    .replace(/\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|ACCESS[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|TOKEN))(["']?\s*[=:]\s*["']?)(?!\$)(?![A-Za-z]{1,11}(?![\w+/=-]))(?![A-Za-z]+\s*[=<])[^\s"']{6,}/gi, '$1$2••••')
}
