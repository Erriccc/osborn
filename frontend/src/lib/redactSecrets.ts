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
// .ts SECRET_RULES) but are not identical to them; re-typed because that module
// imports node:fs. Still unmasked here: npm_, AIza, xox*, AKIA, fw_, snx_, PEM.
//
// RULE FOR EDITORS: never raise a floor and never drop a separator to make text
// read better. A higher floor prints short real credentials (a LiveKit key is
// "API" + ~12 chars); dropping ":" un-masks every `NAME_SECRET: value` block.
// Both have happened here. When a rule over-reaches, narrow it by SHAPE: see
// NOT_A_VALUE, which is why `apiKey: string` in a diff survives untouched.
//
// A credential is never a single short word: `string`, `number`, `None`,
// `expired`, `header`, `required` are what follows a key-ish name in a type
// annotation, a diff or a sentence — never a secret. Pure letters up to 11 of
// them are therefore not a value. A real token is longer or mixes in digits,
// punctuation or case, so this costs no coverage.
const NOT_A_VALUE = /(?![A-Za-z]{1,11}\b)/.source

export function redactSecrets(s: string | undefined | null): string {
  if (!s) return s ?? ''
  return s
    .replace(/sk-(ant|or)-[A-Za-z0-9_-]{6,}/g, 'sk-$1-••••')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-••••')
    .replace(/sbp_[A-Za-z0-9]{10,}/g, 'sbp_••••')
    .replace(/\bg(?:h[pousr]|ithub_pat)_[A-Za-z0-9_]{10,}/g, 'gh_••••')
    // A real Fly macaroon is a comma-separated list of segments; redact the
    // whole list, not just the first one.
    .replace(/FlyV1\s+fm[12]_[A-Za-z0-9/+_=-]+(?:\s*,\s*fm[12]_[A-Za-z0-9/+_=-]+)*/g, 'FlyV1 ••••')
    .replace(/(?<![A-Za-z0-9])(?:fm[12]|fo1)_[A-Za-z0-9/+_=-]{20,}/g, 'fly_••••')
    // Two segments, short header: a truncated JWT is still a credential.
    .replace(/eyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}/g, 'eyJ••••')
    .replace(new RegExp(`(\\b(?:x-goog-|x-)?api-key["'\`]?\\s*[:=]\\s*["'\`]?)(?!\\$)${NOT_A_VALUE}[^\\s"'\`,;}]{8,}`, 'gi'), '$1••••')
    .replace(new RegExp(`(Authorization["'\`]?\\s*:\\s*["'\`]?(?:(?:Bearer|Basic|Token)\\s+)?)(?!\\$)${NOT_A_VALUE}[^\\s"'\`,;}]{8,}`, 'gi'), '$1••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{20,}/gi, '$1••••')
    // "=" OR ":" — a .env line and a YAML/JSON block are both common in results.
    .replace(new RegExp(`\\b([A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|ACCESS[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|TOKEN))(\\s*[=:]\\s*)(["']?)${NOT_A_VALUE}([^\\s"']{6,})\\3`, 'gi'), '$1$2$3••••$3')
}
