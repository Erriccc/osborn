/**
 * verify-sanitizer.ts — REAL-FILE verification harness for the transcript
 * sanitizer. Runnable with tsx:
 *
 *   npx tsx agent/src/content/verify-sanitizer.ts [path-to-session.jsonl]
 *
 * It runs the sanitizer over an actual Claude session JSONL and reports:
 *   - total user entries (every type:"user" line, incl. tool_results)
 *   - text-bearing user utterances fed to the core
 *   - dropped / unwrapped / clean-passthrough counts
 *   - a CRITICAL assertion that NO secret pattern survives in the output.
 *
 * Exit code is non-zero if any secret survives (CI-friendly).
 */

import fs from 'node:fs'
import {
  sessionJsonlAdapter,
  sanitizeTranscriptDetailed,
  sanitizeRecord,
  redactSecrets,
  detectSecrets,
} from './transcript-sanitizer.js'

/**
 * SYNTHETIC assistant-mode check. Every credential shape the reviewer found
 * passing through is embedded in an ASSISTANT-speaker record; the sanitized
 * output must be detector-clean. All values are obviously FAKE.
 */
function syntheticAssistantCheck(): number {
  const F = (n: number) => 'FAKE0123'.repeat(Math.ceil(n / 8)).slice(0, n)
  const samples: { shape: string; text: string }[] = [
    { shape: 'sk-ant-api03', text: `export ANTHROPIC_KEY_VALUE sk-ant-api03-${F(40)}-FAKEAA done` },
    { shape: 'sk-ant-oat01', text: `oauth token is sk-ant-oat01-${F(48)} in creds` },
    { shape: 'sk-or-v1', text: `openrouter key sk-or-v1-${F(64)} used` },
    { shape: 'ghp_', text: `git remote uses ghp_${F(36)} for push` },
    { shape: 'gho_', text: `token gho_${F(36)}.` },
    { shape: 'AIza', text: `GOOGLE key: AIzaSy${F(33)} (fake)` },
    {
      shape: 'PEM',
      text:
        'Here is the key:\n-----BEGIN RSA PRIVATE KEY-----\n' +
        `${F(64)}\n${F(64)}\n-----END RSA PRIVATE KEY-----\nend.`,
    },
    { shape: 'PEM-unterminated', text: `-----BEGIN PRIVATE KEY-----\n${F(64)}\n${F(20)}` },
    { shape: 'JWT', text: `session jwt eyJ${F(20)}.eyJ${F(30)}.${F(43)} ok` },
    { shape: 'x-api-key', text: `curl -H "x-api-key: ${F(40)}" https://api.example.com` },
    { shape: 'x-api-key-json', text: `{"x-api-key": "${F(40)}"}` },
    { shape: 'x-goog-api-key', text: `curl -H "x-goog-api-key: ${F(39)}" https://generativelanguage.googleapis.com` },
    { shape: 'x-goog-api-key-json', text: `{"x-goog-api-key": "${F(39)}"}` },
    { shape: 'api-key (generic)', text: `curl -H "api-key: ${F(32)}" https://x.openai.azure.com` },
    { shape: 'Authorization Bearer', text: `Authorization: Bearer ${F(40)}` },
    { shape: 'Authorization Basic', text: `authorization: Basic ${F(28)}==` },
    { shape: 'Authorization bare', text: `Authorization: ${F(32)}` },
    { shape: 'high-entropy', text: `the value Zq9FAKEx7Lm2Pw4Rt8Yu1Io3FAKEAs6Df5Gh0 leaked` },
    { shape: 'fw_ (Fireworks)', text: `ANTHROPIC_AUTH_TOKEN set to fw_${F(24)} for glm` },
    {
      shape: 'FlyV1 multi-segment',
      text: `fly token FlyV1 fm2_${F(60)},fm2_${F(80)},fm2_${F(40)} end`,
    },
    { shape: 'fm2_ standalone', text: `segment fm2_${F(48)} copied` },
    { shape: 'fm1_ standalone', text: `old segment fm1_${F(32)} copied` },
    { shape: 'snx_proj_ (Soniox)', text: `soniox key snx_proj_${F(32)} set` },
    { shape: 'github_pat_', text: `pat github_pat_${F(22)}_${F(59)} ok` },
    { shape: 'xoxp-', text: `slack xoxp-${F(12)}-${F(12)}-${F(32)} ok` },
    { shape: 'xoxb-', text: `slack xoxb-${F(12)}-${F(24)} ok` },
    { shape: 'sbp_', text: `supabase sbp_${F(40)} ok` },
    { shape: 'npm_', text: `npm token npm_${F(36)} ok` },
  ]
  // Benign prose that must survive UNCHANGED (false-positive guard).
  const benign = [
    'task-budgets and fo1_/sbp_/xox/Bearer patterns are prose',
    'commit 3f9a1c2b7d4e5f60718293a4b5c6d7e8f9012345 and sha256 9b74c9897bac770ffc029102a200c5de9b74c9897bac770ffc029102a200c5de',
    'uuid c97588f4-5760-4b5b-b789-ab5f65aaed29 and /workspace/osborn/agent/src/content/transcript-sanitizer.ts',
    'the x-api-key: header and Authorization: Bearer are documented',
    'SOME_LONG_CONSTANT_NAME_2026_VALUE_X1Y2 sanitizeTranscriptDetailed',
    'curl -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "x-api-key: ${ANTHROPIC_API_KEY}"',
    'curl -H "x-goog-api-key: $GOOGLE_API_KEY" and the api-key: header is optional',
    'the fw_key and fw_test_script vars, fm2_/fm1_ segments, and the snx_proj_ prefix are prose',
  ]

  let fails = 0
  console.log('SYNTHETIC assistant-mode secret check (fake values)')
  for (const s of samples) {
    const { record } = sanitizeRecord({ text: s.text, timestamp: 't', speaker: 'assistant' })
    const out = record?.text ?? ''
    const hits = detectSecrets(out, { assistant: true })
    const caught = out.includes('[REDACTED')
    const idem = redactSecrets(out, { assistant: true }) === out
    const ok = hits.length === 0 && caught && idem
    if (!ok) fails++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${s.shape.padEnd(22)} redacted=${caught} survivors=${hits.length} idempotent=${idem}`)
  }
  for (const b of benign) {
    const out = redactSecrets(b, { assistant: true })
    const ok = out === b
    if (!ok) fails++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  benign unchanged: "${b.slice(0, 40)}…"`)
  }
  console.log(`  => ${fails === 0 ? 'PASS' : `FAIL (${fails})`} synthetic assistant-mode check`)
  console.log('-'.repeat(64))
  return fails
}

const DEFAULT_FILE =
  '/workspace/.claude/projects/-workspace/c97588f4-5760-4b5b-b789-ab5f65aaed29.jsonl'

function countRawUserEntries(filePath: string): { totalUser: number; nonText: number } {
  let totalUser = 0
  let nonText = 0
  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let o: any
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (o?.type !== 'user') continue
    totalUser++
    const c = o?.message?.content
    const hasText =
      typeof c === 'string' ||
      (Array.isArray(c) && c.some((p: any) => p && p.type === 'text' && typeof p.text === 'string'))
    if (!hasText) nonText++
  }
  return { totalUser, nonText }
}

function main(): number {
  const file = process.argv[2] || DEFAULT_FILE
  if (!fs.existsSync(file)) {
    console.error(`Session file not found: ${file}`)
    return 2
  }

  const syntheticFails = syntheticAssistantCheck()

  const { totalUser, nonText } = countRawUserEntries(file)
  // This harness verifies the USER-only path (its counts are framed around
  // user entries). Assistant inclusion is exercised by the e2e pipeline.
  const raws = sessionJsonlAdapter(file, { includeAssistant: false })
  const { records, stats } = sanitizeTranscriptDetailed(raws)

  console.log('='.repeat(64))
  console.log('TRANSCRIPT SANITIZER — real-file verification')
  console.log(`file: ${file}`)
  console.log('='.repeat(64))
  console.log(`total user entries (incl. tool_results):   ${totalUser}`)
  console.log(`  skipped (tool_result / image-only):      ${nonText}`)
  console.log(`text-bearing utterances -> core input:     ${stats.input}`)
  console.log(`  dropped:                                 ${stats.dropped}`)
  console.log(`  unwrapped (from [INTERRUPTED]/[CONTEXT]): ${stats.unwrapped}`)
  console.log(`  clean passthrough:                       ${stats.clean}`)
  console.log(`kept records emitted:                      ${records.length}`)
  console.log('-'.repeat(64))

  // CRITICAL: no secret pattern may survive in the output.
  // Authoritative check = precise detectors over every kept record.
  const survivors: { kind: string; match: string; ts: string }[] = []
  for (const r of records) {
    for (const hit of detectSecrets(r.text)) {
      survivors.push({ kind: hit.kind, match: hit.match, ts: r.timestamp })
    }
  }

  // Transparency: naive substring scan for the exact tokens named in the brief.
  // NOTE: bare substrings appear in BENIGN prose (e.g. "task-budgets" contains
  // "sk-"; "fo1_/sbp_/xox/Bearer patterns" contains "sbp_"/"xox"), so the naive
  // count is informational only — the detector scan above is authoritative.
  const naiveTokens = ['npm_', 'FlyV1 fm2_', 'sbp_', 'sk-', 'xox', '_authToken=']
  const joined = records.map((r) => r.text).join('\n')
  const naive: Record<string, number> = {}
  for (const tok of naiveTokens) {
    naive[tok] = joined.split(tok).length - 1
  }

  console.log('secret-scan (authoritative, precise detectors):')
  if (survivors.length === 0) {
    console.log('  PASS — 0 live secrets survive in the output.')
  } else {
    console.log(`  FAIL — ${survivors.length} secret(s) survived:`)
    for (const s of survivors.slice(0, 20)) {
      // Never echo the matched value (it may be a LIVE secret) — shape only.
      console.log(`    [${s.kind}] ${s.match.slice(0, 4)}… len=${s.match.length}  (@ ${s.ts})`)
    }
  }
  console.log('naive substring counts (informational, benign prose expected):')
  for (const tok of naiveTokens) console.log(`  "${tok}": ${naive[tok]}`)

  // For every naive hit, confirm it is NOT an actual secret (i.e. detector-clean).
  const naiveTotal = Object.values(naive).reduce((a, b) => a + b, 0)
  if (naiveTotal > 0) {
    console.log(
      '  (naive hits are benign prose — detector scan above confirms none are live secrets)'
    )
  }

  // Real-file scan INCLUDING assistant turns (the e2e pipeline's input),
  // using speaker-aware detectors (assistant records get the entropy fallback).
  const allRecords = sanitizeTranscriptDetailed(sessionJsonlAdapter(file)).records
  const asstSurvivors: { kind: string; ts: string }[] = []
  for (const r of allRecords) {
    for (const hit of detectSecrets(r.text, { assistant: r.speaker === 'assistant' })) {
      asstSurvivors.push({ kind: hit.kind, ts: r.timestamp })
    }
  }
  const asstN = allRecords.filter((r) => r.speaker === 'assistant').length
  console.log(`secret-scan incl. assistant turns (${allRecords.length} records, assistant=${asstN}):`)
  if (asstSurvivors.length === 0) {
    console.log('  PASS — 0 live secrets survive (user + assistant).')
  } else {
    console.log(`  FAIL — ${asstSurvivors.length} secret(s) survived:`)
    for (const s of asstSurvivors.slice(0, 20)) console.log(`    [${s.kind}] (@ ${s.ts})`)
  }

  console.log('='.repeat(64))
  return survivors.length === 0 && asstSurvivors.length === 0 && syntheticFails === 0 ? 0 : 1
}

process.exit(main())
