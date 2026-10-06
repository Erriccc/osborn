/**
 * render-e2e.ts — RENDER leg of the content pipeline (walking skeleton).
 *
 * Grounded script (fixed facts only) ->
 *   1. narration mp3 via OpenRouter /api/v1/audio/speech (per-line, so captions sync exactly)
 *   2. vertical 1080x1920 short: dark background + burned-in ASS captions + narration (ffmpeg)
 *   3. optional AI b-roll via OpenRouter /api/v1/videos (hard cost cap) + b-roll-opening variant
 *   4. text variants (LinkedIn / X / HN) as one markdown file
 * then uploads media to voice-native.com and verifies each URL.
 *
 * Run:  npx tsx agent/src/content/render-e2e.ts      (SKIP_BROLL=1 to skip item 3)
 * Reruns reuse already-downloaded audio/b-roll so they never re-spend.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { redactSecrets } from './transcript-sanitizer.js'

const OUT = '/workspace/.claude/projects/-workspace/osb/c97588f4-5760-4b5b-b789-ab5f65aaed29/render-run-1'
const FFMPEG = process.env.FFMPEG || '/workspace/.local/bin/ffmpeg'
const FFPROBE = process.env.FFPROBE || '/workspace/.local/bin/ffprobe'
const FONT_SRC = '/workspace/audos-com/node_modules/pdfmake/build/fonts/Roboto/Roboto-Medium.ttf'
const OR = 'https://openrouter.ai/api/v1'
const KEY = process.env.OPENROUTER_API_KEY || ''
const TTS_MODEL = 'microsoft/mai-voice-2.1-flash'
const TTS_VOICE = 'en-US-Ethan:MAI-Voice-2.1-Flash'
const TTS_PRICE_PER_CHAR = 0.000015 // from /api/v1/models?output_modalities=speech (prompt price)
const VIDEO_MODEL = 'google/veo-3.1-lite'
const VIDEO_SECONDS = 6
const VIDEO_WORST_PER_SEC = 0.08 // highest listed sku for veo-3.1-lite (with audio, 1080p)
const COST_CAP = 2
const GAP = 0.35 // seconds of silence between lines

// Grounded script: every line maps to one of today's verified facts. Nothing else.
const SCRIPT: string[] = [
  'We built a pipeline that turns a voice coding session transcript into content.',
  'Step one was a front-door sanitizer. It cleaned the real session and redacted secrets before anything else touched it.',
  'Then we widened the input to both sides of the conversation. That took it from about eleven hundred to about thirty-six hundred records.',
  'Then the cheap model wrote its first draft. And it invented a story.',
  "It claimed files were recovered from iCloud's Recently Deleted folder. That never happened.",
  'So we added a truth-check step. It compares every claim in a draft against the real transcript.',
  'On the next run, it flagged every ungrounded sentence in the draft, so we could fix it before posting.',
  'My takeaway: an AI content pipeline needs a fact-check step. Not just a better prompt.',
]
// Caption text (digits read better on screen than spelled-out numbers).
const CAPTIONS = SCRIPT.map((l) => l.replace('about eleven hundred to about thirty-six hundred', 'about 1,100 to about 3,600'))

const log = (...a: unknown[]) => console.log('[render]', ...a)
const ff = (args: string[]) => execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' })
const dur = (f: string) =>
  Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim())
const writeText = (f: string, s: string) => fs.writeFileSync(f, redactSecrets(s))
const auth = { Authorization: `Bearer ${KEY}` }

async function tts(text: string, file: string): Promise<void> {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return
  const r = await fetch(`${OR}/audio/speech`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice: TTS_VOICE, response_format: 'mp3' }),
  })
  if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`)
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
}

function assTime(t: number): string {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

function buildAss(cues: { start: number; end: number; text: string }[], file: string): void {
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Cap,Roboto Medium,74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,4,2,5,110,110,0,1\n' +
    'Style: Tag,Roboto Medium,40,&H0080C8FF,&H0080C8FF,&H00000000,&H00000000,0,0,0,0,100,100,2,0,1,0,0,8,80,80,160,1\n\n' +
    '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
  const total = cues[cues.length - 1].end
  const lines = cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,{\\fad(150,150)}${c.text}`)
  lines.push(`Dialogue: 0,${assTime(0)},${assTime(total)},Tag,,0,0,0,,TRANSCRIPT -> CONTENT  |  FIELD NOTES`)
  fs.writeFileSync(file, head + lines.join('\n') + '\n')
}

async function broll(file: string): Promise<{ ok: boolean; note: string; cost: number }> {
  if (process.env.SKIP_BROLL) return { ok: false, note: 'skipped (SKIP_BROLL set)', cost: 0 }
  if (fs.existsSync(file) && fs.statSync(file).size > 10000) return { ok: true, note: 'reused existing clip', cost: 0 }
  const worst = VIDEO_SECONDS * VIDEO_WORST_PER_SEC
  if (worst > COST_CAP) return { ok: false, note: `skipped: worst-case $${worst} > cap`, cost: 0 }
  const body = {
    model: VIDEO_MODEL, duration: VIDEO_SECONDS, size: '720x1280', generate_audio: false,
    prompt: 'Slow cinematic push-in on a dark desk at night, a laptop screen glowing with scrolling lines of plain text transcript, ' +
      'a red highlight sweeping across a few lines, shallow depth of field, moody blue and amber light, no people, no readable words',
  }
  const s = await fetch(`${OR}/videos`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const sj: any = await s.json().catch(() => ({}))
  if (!s.ok || !sj.id) return { ok: false, note: `submit failed ${s.status}: ${JSON.stringify(sj).slice(0, 300)}`, cost: 0 }
  log('video job', sj.id)
  const t0 = Date.now()
  let job: any = sj
  while (Date.now() - t0 < 10 * 60_000) {
    await new Promise((r) => setTimeout(r, 10_000))
    job = await (await fetch(`${OR}/videos/${sj.id}`, { headers: auth })).json()
    log('video status', job.status, `${Math.round((Date.now() - t0) / 1000)}s`)
    if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) break
  }
  const cost = Number(job?.usage?.cost ?? worst)
  if (job.status !== 'completed') return { ok: false, note: `job ${job.status}: ${JSON.stringify(job.error ?? '').slice(0, 300)}`, cost }
  const c = await fetch(`${OR}/videos/${sj.id}/content`, { headers: auth })
  if (!c.ok) return { ok: false, note: `download failed ${c.status}`, cost }
  fs.writeFileSync(file, Buffer.from(await c.arrayBuffer()))
  return { ok: true, note: `job ${sj.id}, usage.cost=${job?.usage?.cost ?? 'n/a'}`, cost }
}

// The upload endpoint refuses overwrites (RLS), so reruns reuse a prior URL whose remote size matches the local file.
async function upload(file: string, prior?: string): Promise<string> {
  if (prior?.startsWith('https://')) {
    const h = await fetch(prior, { method: 'HEAD' })
    if (h.ok && Number(h.headers.get('content-length')) === fs.statSync(file).size) return prior
  }
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(file)]), `osborn-render-run-1b-${path.basename(file)}`)
  const r = await fetch('https://www.voice-native.com/api/upload', { method: 'POST', body: fd })
  const j: any = await r.json().catch(() => ({}))
  if (!j.url) return `UPLOAD FAILED (${r.status}): ${JSON.stringify(j).slice(0, 200)}`
  const h = await fetch(j.url, { method: 'HEAD' })
  return h.ok ? j.url : `${j.url} (VERIFY FAILED: HEAD ${h.status})`
}

function textVariants(): string {
  const linkedin = [
    'We built a pipeline that turns a voice coding session transcript into content. Here is what actually happened.',
    '',
    'A front-door sanitizer cleaned the real session and redacted secrets before anything else touched it.',
    '',
    'Widening the input to both sides of the conversation took it from about 1,100 to about 3,600 records.',
    '',
    "Then the cheap model wrote its first draft, and it invented a story: it claimed files were recovered from iCloud's Recently Deleted folder. That never happened.",
    '',
    'So we added a truth-check step that compares every claim in a draft against the real transcript. On the next run it flagged every ungrounded sentence in the draft, so we could fix it before posting.',
    '',
    'Lesson: an AI content pipeline needs a fact-check step, not just a better prompt.',
  ].join('\n')
  const x = "Our transcript-to-content pipeline's first draft invented a story: files \"recovered from iCloud's Recently Deleted.\" Never happened. On the next run, a truth-check against the real transcript flagged every ungrounded sentence. You need a fact-check step, not a better prompt."
  if (x.length > 280) throw new Error(`X post is ${x.length} chars`)
  const hn = [
    "One data point from building a transcript-to-content pipeline: the first draft from the cheap model invented a story (it claimed files were recovered from iCloud's Recently Deleted folder, which never happened).",
    '',
    "Prompting harder isn't the fix I'd trust. What worked for us was a separate truth-check step that compares every claim in a draft against the real transcript; on the next run it flagged every ungrounded sentence in the draft, so we could fix it before posting.",
    '',
    "Upstream of that, a sanitizer cleans the session and redacts secrets before anything else touches it, and feeding both sides of the conversation took the input from about 1,100 to about 3,600 records. But the truth-check is the part I'd insist on.",
  ].join('\n')
  return `# Text variants (render-run-1)\n\nAll derived from the same grounded fact list as the narration.\n\n## LinkedIn\n\n${linkedin}\n\n## X / Twitter (${x.length} chars)\n\n${x}\n\n## HN-style comment reply\n\n${hn}\n`
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('OPENROUTER_API_KEY missing — stopping (no fabricated output).')
  fs.mkdirSync(path.join(OUT, 'lines'), { recursive: true })
  fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true })
  fs.copyFileSync(FONT_SRC, path.join(OUT, 'fonts', 'Roboto-Medium.ttf'))
  writeText(path.join(OUT, 'script.txt'), SCRIPT.join('\n') + '\n')
  writeText(path.join(OUT, 'text-variants.md'), textVariants())
  const results: Record<string, any> = {}

  // 1. Narration — one TTS call per line; then concat with short gaps.
  const cues: { start: number; end: number; text: string }[] = []
  const lineFiles: string[] = []
  let t = 0
  for (let i = 0; i < SCRIPT.length; i++) {
    const f = path.join(OUT, 'lines', `line-${i + 1}.mp3`)
    await tts(SCRIPT[i], f)
    const d = dur(f)
    cues.push({ start: t, end: t + d + GAP, text: CAPTIONS[i] })
    t += d + GAP
    lineFiles.push(f)
  }
  // concat FILTER (not demuxer): decodes each line, pads GAP of silence after it, joins at one sample rate.
  const pads = lineFiles.map((_, i) => `[${i}:a]aresample=44100,apad=pad_dur=${GAP}[a${i}]`).join(';')
  const joins = lineFiles.map((_, i) => `[a${i}]`).join('')
  const mp3 = path.join(OUT, 'narration.mp3')
  ff([...lineFiles.flatMap((f) => ['-i', f]), '-filter_complex', `${pads};${joins}concat=n=${lineFiles.length}:v=0:a=1[out]`,
    '-map', '[out]', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', mp3])
  const chars = SCRIPT.join(' ').length
  results.narration = { file: mp3, dur: dur(mp3), cost: chars * TTS_PRICE_PER_CHAR, chars }
  log('narration', results.narration)

  // 2. Vertical short — dark background + captions.
  const ass = path.join(OUT, 'captions.ass')
  buildAss(cues, ass)
  const fontsDir = path.join(OUT, 'fonts')
  const short = path.join(OUT, 'short-captions.mp4')
  const total = results.narration.dur
  ff(['-f', 'lavfi', '-i', `color=c=0x0f1115:s=1080x1920:r=30:d=${total}`, '-i', mp3,
    '-vf', `subtitles=${ass}:fontsdir=${fontsDir}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', short])
  results.short = { file: short, dur: dur(short) }

  // 3. Optional b-roll (never blocks 1-2).
  const brollFile = path.join(OUT, 'broll.mp4')
  try {
    results.broll = { ...(await broll(brollFile)), file: brollFile }
  } catch (e) {
    results.broll = { ok: false, note: `error: ${(e as Error).message}`, cost: 0 }
  }
  if (results.broll.ok) {
    const bd = Math.min(dur(brollFile), total)
    const variant = path.join(OUT, 'short-broll-open.mp4')
    ff(['-i', brollFile, '-f', 'lavfi', '-i', `color=c=0x0f1115:s=1080x1920:r=30:d=${(total - bd).toFixed(3)}`, '-i', mp3,
      '-filter_complex',
      `[0:v]trim=0:${bd},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,` +
      `fade=t=out:st=${(bd - 0.5).toFixed(2)}:d=0.5[b];[1:v]setsar=1[c];[b][c]concat=n=2:v=1:a=0[bg];` +
      `[bg]subtitles=${ass}:fontsdir=${fontsDir}[v]`,
      '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-b:a', '160k',
      '-shortest', '-movflags', '+faststart', variant])
    results.brollShort = { file: variant, dur: dur(variant) }
  }

  // Deliver.
  const resFile = path.join(OUT, 'results.json')
  const prior: Record<string, any> = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : {}
  for (const k of ['narration', 'short', 'broll', 'brollShort']) {
    if (results[k]?.file && fs.existsSync(results[k].file) && (k !== 'broll' || results.broll.ok)) {
      results[k].url = await upload(results[k].file, prior[k]?.url)
      log('uploaded', k, results[k].url)
    }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), redactSecrets(JSON.stringify(results, null, 2)))
  log('done', JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error('[render] FAILED:', e.message)
  process.exit(1)
})
