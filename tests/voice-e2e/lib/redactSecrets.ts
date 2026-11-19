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
// The rules mirror the agent-side sanitizer's (agent/src/content/secret-rules.ts
// SECRET_RULES): every shape it redacts is masked here too, and
// frontend/tests/redaction-parity.test.ts fails when they drift (it runs the
// agent's own detector over this function's output). Mirrored, not imported:
// this file is copied on its own into the browser engine (below), and the agent
// package ships without the frontend. It also masks shapes the agent does not.
//
// The browser engine's public evidence logs use this file too: the harness build
// (frontend/scripts/build-harness-bundle.mjs) copies it byte for byte to
// tests/voice-e2e/lib/redactSecrets.ts, and tests/voice-e2e/lib/devtools.test.ts fails when
// the two differ. Edit this file, then rebuild the bundle.
//
// RULES FOR EDITORS, each learned from a shipped bug:
//  - Never raise a floor to make text read better. A LiveKit key is "API" + ~12
//    chars, so a floor tuned to long values prints short real credentials.
//  - Never drop a separator, and keep them quote-tolerant. `"MY_TOKEN": "…"` from
//    a JSON or `fly secrets` block is as common as a bare .env line, and a
//    separator that cannot cross the name's closing quote leaks all of them.
//  - Do not require a CLOSING quote either: drawer bodies are truncated mid-
//    string, and `MY_TOKEN: "abc…` must still mask.
//  - Narrow by SHAPE instead. Values never mask after `$` (a `$VAR` reference),
//    `<` (a placeholder) or `{` (JSX). The rest depends on the separator:
//     * `NAME=value` with no space around `=` is a .env line, a shell export or
//       a URL parameter, never a type annotation: any value of 5+ characters
//       masks, a symbol-start or quote/paren-split value included, up to the
//       next whitespace, `&`, `;` or `|`. Only `true`, `false`, `null` and the
//       like are spared.
//     * `NAME: value` and spaced `NAME = value` are also code: the guard
//       `(?![A-Za-z]{1,11}(?![\w+/=-]))` spares one short word — `string`,
//       `expired`, `process` in `process.env.X` — as a type annotation, a diff
//       line or a sentence. Its inner class is what keeps it from skipping
//       `sk-proj-…`, `xoxb-…` and `glpat-…` (a plain `\b` fires before a hyphen).
//     * A header value (`x-api-key:`, `Authorization:`) is never a type, so it
//       spares only a word from a short prose list (`header`, `required`, …)
//       or a word ending at a dot (`docs/api-key: rotation.md`).
//    Every separator crosses a closing quote, a backtick or a `\"` on the name.
export function redactSecrets(s: string | undefined | null): string {
  if (!s) return s ?? ''
  return s
    // One rule for every provider key. The floor of 12 on a prefixed body is set
    // by the vendors' own lengths (60-95 chars), not by how prose reads, so it
    // cannot miss a real key — and it stops a doc comment or a regex that merely
    // MENTIONS `sk-ant-oat01-` from being rewritten.
    // NB `([^A-Za-z0-9]|^)…$1` rather than a lookbehind: this module is bundled
    // for the browser, and a lookbehind literal is a PARSE error on Safari < 16.4
    // — it would take down the whole chunk, not just redaction.
    .replace(/([^A-Za-z0-9]|^)sk-(?:(?:ant|or|proj|svcacct)-[A-Za-z0-9_-]{12,}|[A-Za-z0-9]{20,})/g, '$1sk-••••')
    .replace(/sbp_[A-Za-z0-9]{10,}/g, 'sbp_••••')
    .replace(/\bnpm_[A-Za-z0-9]{36,}/g, 'npm_••••')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA••••')
    .replace(/([^A-Za-z0-9_]|^)fw_[A-Za-z0-9]{20,}/g, '$1fw_••••')
    .replace(/([^A-Za-z0-9_]|^)snx_(?:proj_[A-Za-z0-9_-]{20,}|(?!proj_)[A-Za-z0-9]{16,})/g, '$1snx_••••')
    // A private key, terminated or cut off mid-body (a literal `\n` included).
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'PRIVATE KEY ••••')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\sA-Za-z0-9+/=]|\\n)*/g, 'PRIVATE KEY ••••')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza••••')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox••••')
    // Two rules at the agent's floor of 30, not one folded rule: folding them
    // lets the `_` the fine-grained class needs match an identifier like
    // `ghs_installation_cache`, and stops a real github_pat_ body at its first
    // underscore so the tail still prints.
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'gh_••••')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{30,}/g, 'gh_••••')
    // A real Fly macaroon is a comma-separated list of segments; redact the
    // whole list, not just the first one.
    .replace(/FlyV1\s+fm[12]_[A-Za-z0-9/+_=-]+(?:\s*,\s*fm[12]_[A-Za-z0-9/+_=-]+)*/g, 'FlyV1 ••••')
    .replace(/([^A-Za-z0-9]|^)(?:fm[12]|fo1)_[A-Za-z0-9/+_=-]{20,}/g, '$1fly_••••')
    // Two segments, short header: a truncated JWT is still a credential.
    .replace(/eyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}/g, 'eyJ••••')
    // `<` is excluded from every value class below: `Authorization: Bearer
    // <access_token>` and `TOKEN=<paste-here>` are placeholders, not credentials.
    .replace(/(\b(?:x-goog-|x-)?api-key(?:\\?["'`])?\s*[:=]\s*(?:\\?["'`])?)(?!\$)(?!(?:header|headers|required|optional|missing|invalid|expired|undefined|null|none|string|empty|unset|redacted|hidden)(?![\w+/=-]))(?![A-Za-z]{1,11}\.)[^\s"'`\\,;}<]{8,}/gi, '$1••••')
    .replace(/(Authorization(?:\\?["'`])?\s*:\s*(?:\\?["'`])?(?:(?:Bearer|Basic|Token)\s+)?)(?!\$)(?!(?:header|headers|required|optional|missing|invalid|expired|undefined|null|none|string|empty|unset|redacted|hidden)(?![\w+/=-]))(?![A-Za-z]{1,11}\.)[^\s"'`\\,;}<]{8,}/gi, '$1••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]{20,}/gi, '$1••••')
    // `[_-]KEY` and `[_-]PASS` cover this product's own names
    // (SUPABASE_SERVICE_ROLE_KEY, PUSHOVER_USER_KEY, OSBORN_DEMO_PASS) while the
    // separator keeps `MONKEY=` out. First the tight `NAME=value` form (see the
    // editors' rules above): the lazy value stops before an optional closing
    // quote, so `NAME="…"` keeps its quote. The guard repeats the optional quote
    // because the regex may skip the separator's: without it `TOKEN="$VAR"` and
    // an already-masked `TOKEN="••••` would mask (again) from the quote.
    .replace(/\b([A-Za-z0-9_]*(?:API[_-]?KEY|[_-]KEY|SECRET|ACCESS[_-]?KEY|PASSWORD|PASSWD|[_-]PASS|PRIVATE[_-]?KEY|TOKEN))((?:\\?["'`])?=(?:\\?["'`])?)(?!\\?["'`]?(?:\$|<|\{|\[REDACTED|••••|(?:true|false|null|none|nil|undefined|empty|unset)(?![^\s&;|"'`\\])|[A-Z][A-Za-z]*(?:Error|Exception)\b|Unauthorized\b|Forbidden\b))[^\s&;|]{5,}?(?=["'`]?(?:[\s&;|]|$))/gi, '$1$2••••')
    // Then `NAME: value` and spaced `NAME = value`. The value class matches the
    // header rules, so JSX and TS forms — `token={token}`, `token: (row?.sync_token
    // as string)` — are left alone, and the final guard spares a type annotation
    // (`token: AccessTokenPayload = decode(raw)`) that only this rule can reach.
    .replace(/\b([A-Za-z0-9_]*(?:API[_-]?KEY|[_-]KEY|SECRET|ACCESS[_-]?KEY|PASSWORD|PASSWD|[_-]PASS|PRIVATE[_-]?KEY|TOKEN))((?:\\?["'`])?\s*[=:]\s*(?:\\?["'`])?)(?=[A-Za-z0-9])(?![A-Za-z]{1,11}(?![\w+/=-]))(?![A-Za-z]+\s*[=<])(?![A-Z][A-Za-z]*(?:Error|Exception)\b|Unauthorized\b|Forbidden\b)[^\s"'`\\(){}<]{6,}/gi, '$1$2••••')
}
