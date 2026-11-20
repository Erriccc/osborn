/**
 * secret-rules.ts — the secret-redaction rules of the shared transcript
 * sanitizer (./transcript-sanitizer.ts re-exports everything here). Pure, with no
 * imports, so frontend/tests/redaction-parity.test.ts can run them against the
 * Activity log's mirror (frontend/src/lib/redactSecrets.ts).
 */

// ============================================================================
// SECRET REDACTION (source-independent, runs on the FINAL kept text)
// ----------------------------------------------------------------------------
// These transcripts contain LIVE credentials (a real npm token was found in
// session c97588f4). We MASK, never drop — the surrounding sentence stays
// intact so the utterance remains readable.
//
// Length floors matter: benign prose legitimately contains bare substrings
// like "task-budgets" (has "sk-"), "fo1_/sbp_/xox/Bearer patterns", etc. The
// floors ensure we only mask real key-shaped tokens and never mangle words.
// ============================================================================

interface SecretRule {
  kind: string
  /** Global regex. Capture groups allowed; `replace` controls the substitution. */
  re: RegExp
  replace: string
}

/**
 * Order matters. Specific, high-confidence token shapes run FIRST so their KIND
 * label wins; the broad `*_API_KEY=/_SECRET=/_TOKEN=` assignment rule runs LAST
 * to catch any leftover generic value assignment (and skips already-redacted
 * values via a negative lookahead).
 *
 * The Activity log's gate (frontend/src/lib/redactSecrets.ts) mirrors every rule
 * here; frontend/tests/redaction-parity.test.ts fails until a new rule has a
 * sample there and a mirror in the gate.
 */
export const SECRET_RULES: SecretRule[] = [
  // npm registry auth line (contains an npm_ token; redact the whole value).
  {
    kind: 'NPM-AUTH',
    re: /\/\/registry\.npmjs\.org\/:_authToken=[^\s"'`]+/g,
    replace: '//registry.npmjs.org/:_authToken=[REDACTED-NPM-AUTH]',
  },
  // npm granular/automation token: npm_ + 36 base62 chars.
  { kind: 'NPM-TOKEN', re: /npm_[A-Za-z0-9]{36}/g, replace: '[REDACTED-NPM-TOKEN]' },
  // Fly.io macaroon tokens. A real token is a COMMA-SEPARATED list of
  // segments ("FlyV1 fm2_<a>,fm2_<b>,fm2_<c>"); redact the WHOLE list, not just
  // the first segment (the segment char class has no comma, so the old rule
  // stopped at the first "," and leaked the rest).
  {
    kind: 'FLY-TOKEN',
    re: /FlyV1\s+fm[12]_[A-Za-z0-9/+_=-]+(?:\s*,\s*fm[12]_[A-Za-z0-9/+_=-]+)*/g,
    replace: '[REDACTED-FLY-TOKEN]',
  },
  // Standalone Fly macaroon segment without the FlyV1 prefix (floor skips bare
  // "fm2_" word mentions).
  {
    kind: 'FLY-TOKEN',
    re: /(?<![A-Za-z0-9])fm[12]_[A-Za-z0-9/+_=-]{20,}/g,
    replace: '[REDACTED-FLY-TOKEN]',
  },
  // Fly GraphQL fo1_ token (floor skips bare "fo1_" word mentions).
  { kind: 'FLY-TOKEN', re: /fo1_[A-Za-z0-9/+_=-]{20,}/g, replace: '[REDACTED-FLY-TOKEN]' },
  // Supabase personal access token (real = 40 hex; floor skips "sbp_/" prose).
  { kind: 'SUPABASE-PAT', re: /sbp_[A-Za-z0-9]{20,}/g, replace: '[REDACTED-SUPABASE-PAT]' },
  // PEM private key blocks (multiline). Terminated block first, then a
  // truncated/unterminated block (header + base64 body, literal "\n" allowed;
  // a legacy encrypted key's Proc-Type/DEK-Info lines too). Both spans are
  // bounded so a run of BEGIN lines cannot make each one rescan the text.
  {
    kind: 'PEM-PRIVATE-KEY',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[^-]|-(?!----)){0,8192}-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED-PEM-PRIVATE-KEY]',
  },
  {
    kind: 'PEM-PRIVATE-KEY',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\w+/=:,]|-(?!----)|\\n){0,8192}/g,
    replace: '[REDACTED-PEM-PRIVATE-KEY]',
  },
  // Anthropic keys: sk-ant-api03-…, sk-ant-oat01-… (MUST run before OPENAI-KEY).
  { kind: 'ANTHROPIC-KEY', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED-ANTHROPIC-KEY]' },
  // OpenRouter / OpenAI prefixed keys whose body contains _ or - (sk-or-v1-, sk-proj-, sk-svcacct-).
  {
    kind: 'OPENAI-KEY',
    re: /\bsk-(?:or-v1-|or-|proj-|svcacct-)[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED-OPENAI-KEY]',
  },
  // OpenAI / OpenRouter keys (sk-, sk-or-, sk-proj-). Floor skips "task-budgets".
  { kind: 'OPENAI-KEY', re: /sk-(?:or-|proj-)?[A-Za-z0-9]{20,}/g, replace: '[REDACTED-OPENAI-KEY]' },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ (+ fine-grained github_pat_).
  { kind: 'GITHUB-TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, replace: '[REDACTED-GITHUB-TOKEN]' },
  { kind: 'GITHUB-TOKEN', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g, replace: '[REDACTED-GITHUB-TOKEN]' },
  // Google API key.
  { kind: 'GOOGLE-API-KEY', re: /AIza[0-9A-Za-z_-]{35}/g, replace: '[REDACTED-GOOGLE-API-KEY]' },
  // Fireworks AI key: fw_ + ~24 base62 chars. Floor of 20 pure alphanumerics
  // skips snake_case identifiers like "fw_key" / "fw_test_script".
  {
    kind: 'FIREWORKS-KEY',
    re: /(?<![A-Za-z0-9_])fw_[A-Za-z0-9]{20,}/g,
    replace: '[REDACTED-FIREWORKS-KEY]',
  },
  // Soniox project key: snx_proj_ + key body (floor skips bare prefix mentions).
  {
    kind: 'SONIOX-KEY',
    re: /(?<![A-Za-z0-9_])snx_proj_[A-Za-z0-9_-]{20,}/g,
    replace: '[REDACTED-SONIOX-KEY]',
  },
  // Bare Soniox key (snx_<body>, no proj_ segment); the 16-char floor skips prefix mentions.
  {
    kind: 'SONIOX-KEY',
    re: /(?<![A-Za-z0-9_])snx_(?!proj_)[A-Za-z0-9]{16,}/g,
    replace: '[REDACTED-SONIOX-KEY]',
  },
  // JWTs (header.payload.signature, base64url). The lookbehind keeps a long
  // `eyJeyJ…` run from restarting at every `eyJ`, yet still masks a token glued
  // to a word character (`%20eyJ…`, an escaped `\neyJ…`).
  {
    kind: 'JWT',
    re: /(?<!eyJ[A-Za-z0-9_-]*?)eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: '[REDACTED-JWT]',
  },
  // API-key headers: x-api-key, x-goog-api-key (Gemini REST), and generic api-key
  // (Azure etc.) — curl -H, JSON headers, raw HTTP. Keeps the header name, masks
  // the value. Floor of 8 skips prose like "x-api-key: header".
  {
    kind: 'X-API-KEY',
    // (?!\$) skips $VAR / ${var} references — not secrets, just noise.
    re: /(\b(?:x-goog-|x-)?api-key["'`]?\s*[:=]\s*["'`]?)(?!\[REDACTED|\$)[^\s"'`,;}]{8,}/gi,
    replace: '$1[REDACTED-API-KEY]',
  },
  // Authorization header (optional Bearer/Basic/Token scheme). Keeps name +
  // scheme, masks the credential.
  {
    kind: 'AUTH-HEADER',
    re: /(Authorization["'`]?\s*:\s*["'`]?(?:(?:Bearer|Basic|Token)\s+)?)(?!\[REDACTED|\$)[^\s"'`,;}]{8,}/gi,
    replace: '$1[REDACTED-AUTH]',
  },
  // Slack tokens xoxb-/xoxa-/xoxp-/xoxr-/xoxs- (floor skips "xox/" prose).
  { kind: 'SLACK-TOKEN', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[REDACTED-SLACK-TOKEN]' },
  // AWS access key id.
  { kind: 'AWS-KEY', re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[REDACTED-AWS-KEY]' },
  // Generic Bearer token (keep the word "Bearer"; floor skips "Bearer patterns").
  { kind: 'BEARER', re: /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/g, replace: 'Bearer [REDACTED-TOKEN]' },
  // Generic *_API_KEY= / *_SECRET= / *_TOKEN= / *_ACCESS_KEY= / *_PASSWORD= assignments.
  // Keeps NAME= and any surrounding quote; masks only the value. Skips values
  // already replaced by a specific rule above (negative lookahead on [REDACTED).
  {
    kind: 'ENV-SECRET',
    re: /\b([A-Za-z0-9_]*(?:API_KEY|SECRET|ACCESS_KEY|PASSWORD|TOKEN))(\s*=\s*)(["'`“”]?)(?!\[REDACTED)([^\s"'`“”]{6,})\3/g,
    replace: '$1$2$3[REDACTED-ENV-SECRET]$3',
  },
]

/**
 * Conservative high-entropy fallback, applied to ASSISTANT records only (the
 * assistant echoes tool output, so unknown-vendor keys can leak there). Matches
 * a standalone 32+ char token of [A-Za-z0-9_+=-] that has at least one
 * uppercase, one lowercase, and four digits. Mixed-case + digit floor skips
 * git SHAs / sha256 hex / UUIDs (lowercase) and CONSTANT_NAMES (no lowercase);
 * the "/" and "." boundaries skip paths and dotted identifiers. Measured 0 hits
 * across 2508 real assistant records in session c97588f4 (no false positives).
 */
export const HIGH_ENTROPY_RULE: SecretRule = {
  kind: 'HIGH-ENTROPY',
  re: /(?<![A-Za-z0-9_+=\/.\[-])(?=[A-Za-z0-9_+=-]*[A-Z])(?=[A-Za-z0-9_+=-]*[a-z])(?=(?:[A-Za-z0-9_+=-]*\d){4})[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=\/.\]-])/g,
  replace: '[REDACTED-HIGH-ENTROPY]',
}

export interface SecretScanOptions {
  /** Treat as an assistant record: also apply the high-entropy fallback. */
  assistant?: boolean
}

function rulesFor(opts: SecretScanOptions = {}): SecretRule[] {
  return opts.assistant ? [...SECRET_RULES, HIGH_ENTROPY_RULE] : SECRET_RULES
}

/** Mask every secret-shaped substring in `text`. Pure. */
export function redactSecrets(text: string, opts: SecretScanOptions = {}): string {
  let out = text
  for (const rule of rulesFor(opts)) {
    out = out.replace(rule.re, rule.replace)
  }
  return out
}

/**
 * Detector used by the verification harness: returns the list of secret KINDs
 * that STILL match `text`. The authoritative "no secret survives" invariant is
 * `detectSecrets(output).length === 0`. This is precise (uses the same shapes
 * as redaction) rather than a naive substring scan, which would false-positive
 * on benign prose like "task-budgets" or "fo1_/sbp_/xox/Bearer patterns".
 */
export function detectSecrets(
  text: string,
  opts: SecretScanOptions = {}
): { kind: string; match: string }[] {
  const hits: { kind: string; match: string }[] = []
  for (const rule of rulesFor(opts)) {
    // Fresh regex so lastIndex state never leaks between calls.
    const re = new RegExp(rule.re.source, rule.re.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      // The ENV-SECRET rule legitimately leaves a "NAME=[REDACTED-...]" shell;
      // that is NOT a surviving secret, so ignore matches whose value is already redacted.
      if (m[0].includes('[REDACTED')) {
        if (m.index === re.lastIndex) re.lastIndex++
        continue
      }
      hits.push({ kind: rule.kind, match: m[0] })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return hits
}
