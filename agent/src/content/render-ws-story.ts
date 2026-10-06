/**
 * render-ws-story.ts — "one missing header" short: code-server WebSocket 1006 behind a reverse proxy.
 *
 * Stages (STAGE env): screens | check | all (default all)
 *   1. screens: real-artifact screens (code, logs, diagrams) -> PNG via sharp/librsvg
 *   2. check:   truth-check (same guard prompt as pipeline-e2e.ts): draft + source records -> ungrounded claims
 *   3. narration per line via OpenRouter TTS (mai-voice-2.1-flash, en-US-Ethan) -> cue timings
 *   4. per-screen segments with subtle zoom/drift, chunked burned captions, mux -> final mp4
 *   5. verify (probe + frame strip), upload with unique prefix, re-download + probe
 * Run: npx tsx agent/src/content/render-ws-story.ts   (reruns reuse cached TTS so they never re-spend)
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { redactSecrets } from './transcript-sanitizer.js'
import { SCRIPT, CAPTIONS, SCREENS, LINE_SCREENS, PROVENANCE } from './render-ws-data.js'
import { pngPath } from './render-ws-screens.js'

const SESSION_DIR = '/workspace/.claude/projects/-workspace/osb/c97588f4-5760-4b5b-b789-ab5f65aaed29'
const OUT = path.join(SESSION_DIR, 'render-ws-1006')
const FONTS = path.join(OUT, 'fonts')
process.env.FONTCONFIG_FILE = path.join(FONTS, 'fonts.conf')
const FFMPEG = '/workspace/.local/bin/ffmpeg', FFPROBE = '/workspace/.local/bin/ffprobe'
const OR = 'https://openrouter.ai/api/v1'
const KEY = process.env.OPENROUTER_API_KEY || ''
const TTS_MODEL = 'microsoft/mai-voice-2.1-flash', TTS_VOICE = 'en-US-Ethan:MAI-Voice-2.1-Flash'
const TTS_PRICE_PER_CHAR = 0.000015
const CHECK_MODEL = 'deepseek/deepseek-chat'
const COST_CAP = 1
const GAP = 0.3
const TEMPO = Number(process.env.TEMPO || 1.12)
const STAGE = process.env.STAGE || 'all'

const log = (...a: unknown[]) => console.log('[ws-story]', ...a)
const ff = (args: string[]) => execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' })
const dur = (f: string) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim())
// Secrets + the session cookie shape + the machine hostname never leave this script.
const scrub = (s: string) => redactSecrets(s).replace(/osborn_ide=[0-9a-f]+/g, 'osborn_ide=[REDACTED]').replace(/osborn-[0-9a-f]{8}-v2/g, '<app>')
const writeText = (f: string, s: string) => fs.writeFileSync(f, scrub(s))
let spent = 0

async function renderScreens(): Promise<void> {
  const sharp = (await import('sharp')).default
  fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true })
  for (const [name, svg] of Object.entries(SCREENS)) {
    await sharp(Buffer.from(svg())).png().toFile(pngPath(OUT, name))
  }
  log('screens rendered:', Object.keys(SCREENS).length)
}

// ---- truth-check (prompt identical to pipeline-e2e.ts LEG 5) ----
const RECALL_QUERIES = [
  'x-forwarded-host websocket 1006 code-server', 'Unexpected server response: 403', 'WS host/origin matching tests',
  'FLY-EDGE HTTP status', 'raw node:net tunnel replaced http-proxy ws 1006', 'cloudflare tunnel worked hand-rolled tunnel bug is ours',
  'x-forwarded-host 0.9.153 committed dist', 'terminal opens ls runs file tree loads', 'no Origin header falsely passes',
  'WebSocket close with status code 1006 screenshot',
]
function buildSources(): string {
  const lens = fs.readFileSync(path.join(SESSION_DIR, 'lens-backfill-full.md'), 'utf8')
  const angle = lens.slice(lens.indexOf('#### Why your browser WebSocket'), lens.indexOf('#### Why your Claude Code tool-loop'))
  const capStart = lens.indexOf('- **Root-caused WebSocket 1006')
  const cap = lens.slice(capStart, lens.indexOf('- **Root-caused and fixed code-server zombie'))
  const note = fs.readFileSync(path.join(SESSION_DIR, 'editor-followups-and-origin-fix.md'), 'utf8').split('## FOLLOW-UP LIST')[0]
  const recall = RECALL_QUERIES.map((q) =>
    execFileSync('osborn-recall', [q, '--top-k', '4', '--max-chars', '1800'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).join('\n')
  const code = execFileSync('git', ['-C', '/workspace/osborn', 'log', '--oneline', '-G', 'x-forwarded-host|createProxyServer', '--', 'agent/src/index.ts']).toString()
  return scrub(`## Lens angle 4\n${angle}\n## Lens capability\n${cap}\n## Session note\n${note}\n## git log (index.ts)\n${code}\n## Recall rows\n${recall}`)
}
function buildDraft(): string {
  const onScreen = Object.keys(PROVENANCE).filter((k) => !/REENACTMENT/.test(PROVENANCE[k]))
  return 'NARRATION (one line per caption):\n' + CAPTIONS.map((c, i) => `${i + 1}. ${c}`).join('\n') +
    '\n\nON-SCREEN LABELS:\n- before · 0.9.152 (http-proxy swap, still 1006)\n- after · shipped in 0.9.153\n' +
    '- Cloudflare quick tunnel -> terminal works; Own reverse proxy (Fly edge) -> WebSocket close 1006\n' +
    '- Proxy forwards Host: 127.0.0.1:8300, X-Forwarded-Host never sent; code-server authenticateOrigin() -> 403 -> 1006\n' +
    `- screens with real artifacts: ${onScreen.join(', ')}`
}
async function truthCheck(): Promise<string[]> {
  const sources = buildSources(), draft = buildDraft()
  writeText(path.join(OUT, 'truth-check-sources.txt'), sources)
  const system = 'You are a strict fact-checking editor. You are given a DRAFT post and the SOURCE records (the ONLY ' +
    'ground truth). Identify every factual claim, event, metric, or specific detail in the draft that is ' +
    'NOT directly supported by the source records. Treat invented stories, numbers, or named mechanisms as ' +
    'unsupported. Do NOT rewrite or soften the post. Return ONLY a JSON array of strings — each string one ' +
    'specific ungrounded claim (quote or tight paraphrase from the draft). If every claim is grounded, return [].'
  const user = `SOURCE RECORDS (ground truth, speaker-tagged):\n${sources}\n\nDRAFT POST:\n${draft}\n\nList the ungrounded claims as a JSON array of strings.`
  const r = await fetch(`${OR}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CHECK_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: 900, usage: { include: true } }),
  })
  if (!r.ok) throw new Error(`truth-check HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j: any = await r.json()
  spent += Number(j?.usage?.cost ?? 0)
  let s = String(j?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  s = s.slice(s.indexOf('['), s.lastIndexOf(']') + 1)
  const flags: string[] = JSON.parse(s).map((x: any) => String(x).trim()).filter(Boolean)
  writeText(path.join(OUT, 'truth-check.md'),
    `# Truth-check (${CHECK_MODEL}, prompt = pipeline-e2e LEG 5)\n\ncost: $${Number(j?.usage?.cost ?? 0).toFixed(4)} · source chars: ${sources.length}\n\n` +
    `## Draft checked\n\n${draft}\n\n## Ungrounded claims flagged (${flags.length})\n\n` + (flags.map((f, i) => `${i + 1}. ${f}`).join('\n') || '(none)') + '\n')
  log(`truth-check: ${flags.length} flag(s)`, flags)
  return flags
}

async function tts(text: string, file: string): Promise<void> {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return
  if (spent + text.length * TTS_PRICE_PER_CHAR > COST_CAP) throw new Error('cost cap reached')
  const r = await fetch(`${OR}/audio/speech`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice: TTS_VOICE, response_format: 'mp3' }),
  })
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`)
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
  spent += text.length * TTS_PRICE_PER_CHAR
}

const assTime = (t: number) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}
/** Chunked captions (<=4 words, breaking at punctuation), timed proportionally to characters inside each spoken line. */
function buildAss(cues: { start: number; speech: number }[], file: string): void {
  const head = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Cap,Roboto Medium,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H50000000,0,0,0,0,100,100,0,0,3,18,0,2,80,80,300,1\n\n' +
    '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
  const ev: string[] = []
  CAPTIONS.forEach((line, i) => {
    const chunks: string[] = []
    let cur: string[] = []
    for (const w of line.split(/\s+/)) {
      cur.push(w)
      if (cur.length >= 4 || /[.,:;!?]$/.test(w)) { chunks.push(cur.join(' ')); cur = [] }
    }
    if (cur.length) chunks.push(cur.join(' '))
    const total = chunks.reduce((a, c) => a + c.length + 2, 0)
    let t = cues[i].start
    for (const c of chunks) {
      const d = (cues[i].speech * (c.length + 2)) / total
      ev.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},Cap,,0,0,0,,${c}`)
      t += d
    }
  })
  fs.writeFileSync(file, head + ev.join('\n') + '\n')
}

async function upload(file: string, prefix: string): Promise<string> {
  const name = `${prefix}-${path.basename(file)}`
  const out = execFileSync('curl', ['-s', '-X', 'POST', 'https://www.voice-native.com/api/upload', '-F', `file=@${file};filename=${name}`]).toString()
  const url = JSON.parse(out).url
  if (!url) throw new Error(`upload failed: ${out.slice(0, 200)}`)
  return url
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('OPENROUTER_API_KEY missing — stopping (no fabricated output).')
  fs.mkdirSync(path.join(OUT, 'lines'), { recursive: true })
  fs.mkdirSync(path.join(OUT, 'segs'), { recursive: true })
  await renderScreens()
  if (STAGE === 'screens') return
  writeText(path.join(OUT, 'script.txt'), SCRIPT.map((s, i) => `${i + 1}. ${s}\n   [caption] ${CAPTIONS[i]}\n   [screens] ${LINE_SCREENS[i].join(', ')}`).join('\n') + '\n')
  const flags = await truthCheck()
  if (STAGE === 'check') { log(`spent $${spent.toFixed(4)}`); return }
  if (flags.length && !process.env.FLAGS_RESOLVED) throw new Error('truth-check flagged claims — resolve or set FLAGS_RESOLVED=1 after documenting')

  // Narration
  const cues: { start: number; speech: number; end: number }[] = []
  const lineFiles: string[] = []
  let t = 0
  for (let i = 0; i < SCRIPT.length; i++) {
    const h = crypto.createHash('sha1').update(SCRIPT[i]).digest('hex').slice(0, 8)
    const raw = path.join(OUT, 'lines', `line-${i + 1}-${h}.mp3`)
    await tts(SCRIPT[i], raw)
    // Compress pauses > 0.3s (the voice leaves up to ~2.6s) and apply a mild tempo lift.
    const f = raw.replace(/\.mp3$/, '.tight.wav')
    ff(['-i', raw, '-af', `silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_duration=0.3:stop_threshold=-45dB:stop_silence=0.22,atempo=${TEMPO}`, '-ar', '44100', f])
    const d = dur(f)
    cues.push({ start: t, speech: d, end: t + d + GAP }); t += d + GAP; lineFiles.push(f)
  }
  const tail = 1.2
  const pads = lineFiles.map((_, i) => `[${i}:a]aresample=44100,apad=pad_dur=${i === lineFiles.length - 1 ? GAP + tail : GAP}[a${i}]`).join(';')
  const mp3 = path.join(OUT, 'narration.mp3')
  ff([...lineFiles.flatMap((f) => ['-i', f]), '-filter_complex', `${pads};${lineFiles.map((_, i) => `[a${i}]`).join('')}concat=n=${lineFiles.length}:v=0:a=1[out]`,
    '-map', '[out]', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', mp3])
  cues[cues.length - 1].end += tail
  const ass = path.join(OUT, 'captions.ass')
  buildAss(cues, ass)

  // Segments: each line's screens split evenly; subtle zoom (alternating in/out) + vertical drift.
  const segs: string[] = []
  const shotlist: string[] = []
  cues.forEach((c, i) => {
    const names = LINE_SCREENS[i], d = (c.end - c.start) / names.length
    names.forEach((n, k) => {
      const idx = segs.length, zin = idx % 2 === 0
      const z = zin ? `1+0.04*t/${d.toFixed(3)}` : `1.04-0.04*t/${d.toFixed(3)}`
      const seg = path.join(OUT, 'segs', `seg-${String(idx).padStart(2, '0')}.mp4`)
      ff(['-loop', '1', '-framerate', '30', '-t', d.toFixed(3), '-i', pngPath(OUT, n), '-vf',
        `scale=w='trunc(1080*(${z})/2)*2':h=-2:eval=frame,crop=1080:1920:x='(iw-1080)/2':y='(ih-1920)*${zin ? '0.35' : '0.65'}',setsar=1,fps=30,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-an', seg])
      segs.push(seg)
      shotlist.push(`${(c.start + k * d).toFixed(2)}s-${(c.start + (k + 1) * d).toFixed(2)}s  line ${i + 1}  ${n}  — ${PROVENANCE[n]}`)
    })
  })
  const list = path.join(OUT, 'segs', 'list.txt')
  fs.writeFileSync(list, segs.map((s) => `file '${s}'`).join('\n') + '\n')
  const silent = path.join(OUT, 'segs', 'video.mp4')
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent])
  const final = path.join(OUT, 'ws-1006-one-missing-header.mp4')
  ff(['-i', silent, '-i', mp3, '-vf', `subtitles=${ass}:fontsdir=${FONTS}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', final])
  writeText(path.join(OUT, 'shotlist.txt'), shotlist.join('\n') + '\n')

  // Verify: contact strip of 12 evenly spaced frames.
  const D = dur(final)
  const strip = path.join(OUT, 'frames-strip.jpg')
  ff(['-i', final, '-vf', `fps=12/${D.toFixed(2)},scale=270:480,tile=6x2:padding=6:color=black`, '-frames:v', '1', '-q:v', '3', strip])
  const prefix = `wsfix1006-${crypto.randomBytes(4).toString('hex')}`
  const res: Record<string, any> = { duration: D, spent_usd: Number(spent.toFixed(4)), truthCheckFlags: flags, prefix }
  if (!process.env.SKIP_UPLOAD) {
    res.mp4 = await upload(final, prefix)
    res.strip = await upload(strip, prefix)
    const dl = path.join(OUT, 'downloaded-check.mp4')
    execFileSync('curl', ['-sfL', '-o', dl, res.mp4])
    res.downloaded = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'compact', dl]).toString().trim()
  }
  writeText(path.join(OUT, 'results.json'), JSON.stringify(res, null, 2))
  log('done', JSON.stringify(res, null, 2))
}

main().catch((e) => { console.error('[ws-story] FAILED:', e.message); process.exit(1) })
