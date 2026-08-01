'use client'

/**
 * MEETING CANVAS — the bot's face + voice inside a meeting.
 *
 * Recall.ai renders THIS page as the meeting bot's camera (and pipes its audio
 * in as the bot's mic — see docs.recall.ai/docs/output-video-in-meetings). So
 * whatever this page shows, the meeting sees; whatever it speaks, the meeting
 * hears. It's a pure presentational surface driven entirely by the osborn agent
 * over Server-Sent Events — no LiveKit, no auth (Recall loads it server-side).
 *
 * URL: /meeting-canvas?agent=<https-agent-url>
 *   Opens EventSource(`${agent}/canvas-stream`) and reacts to:
 *     { kind:'say',  text }                         → speechSynthesis → meeting hears it
 *     { kind:'show', mode:'idle'|'notes'|'link'|'web'|'text', title?, items?, url?, text? }
 *
 * Design for a 1280×720 camera tile: big type, high contrast, dark brand.
 */

import { useEffect, useRef, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

type Show = {
  mode: 'idle' | 'notes' | 'stream' | 'link' | 'web' | 'text'
  title?: string
  items?: string[]
  url?: string
  text?: string
}

function speak(text: string) {
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.02
    u.pitch = 1.0
    // Prefer a natural en voice if one has loaded.
    const v = synth.getVoices().find((x) => /en[-_]/i.test(x.lang) && /Google|Natural|Samantha|Aria/i.test(x.name))
      || synth.getVoices().find((x) => /^en/i.test(x.lang))
    if (v) u.voice = v
    synth.speak(u)
  } catch { /* speech unavailable */ }
}

// Play agent TTS via the Web Audio API — decode + playback happen on the audio
// rendering thread, NOT the main thread. Osborn's own in-meeting debugging found
// (A/B, 3×) that an `<audio>` element (or SpeechSynthesis) goes choppy when a
// heavy iframe is rendering in the canvas ("web" mode) because they contend for
// the main thread. Web Audio is immune to that, so visual (browsing) + audio
// (speaking) work simultaneously. One shared AudioContext avoids memory churn.
let sharedAudioCtx: AudioContext | null = null
let currentTTSSource: AudioBufferSourceNode | null = null
// QUEUED playback (2026-08-01): consecutive `say` events used to CUT each
// other off (stopTTS on every new say) — heard live as "clunky" choppy speech
// when the agent sent sentence-by-sentence says. Now says play SEQUENTIALLY;
// only an explicit {kind:'stop'} interrupt cuts audio and clears the queue.
let ttsQueue: string[] = []
let ttsDraining = false
async function playTTS(url: string): Promise<void> {
  ttsQueue.push(url)
  if (!ttsDraining) void drainTTSQueue()
}
async function drainTTSQueue(): Promise<void> {
  ttsDraining = true
  while (ttsQueue.length > 0) {
    const url = ttsQueue.shift()!
    try { await playOneTTS(url) } catch { /* skip bad clip, keep queue moving */ }
  }
  ttsDraining = false
}
async function playOneTTS(url: string): Promise<void> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) throw new Error('no AudioContext')
  if (!sharedAudioCtx) sharedAudioCtx = new Ctx()
  if (sharedAudioCtx.state === 'suspended') { try { await sharedAudioCtx.resume() } catch { /* ignore */ } }
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`tts ${resp.status}`)
  const bytes = await resp.arrayBuffer()
  const decoded = await sharedAudioCtx.decodeAudioData(bytes)
  await new Promise<void>((resolve) => {
    const src = sharedAudioCtx!.createBufferSource()
    src.buffer = decoded
    src.connect(sharedAudioCtx!.destination)
    src.onended = () => { if (currentTTSSource === src) currentTTSSource = null; resolve() }
    currentTTSSource = src
    src.start()
  })
}
// Interruption: cut the bot's audio immediately (a human started talking)
// AND drop anything queued — they interrupted the whole thought.
function stopTTS() {
  ttsQueue = []
  try { currentTTSSource?.stop() } catch { /* already stopped */ }
  currentTTSSource = null
  try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
}

function CanvasInner() {
  const params = useSearchParams()
  const agent = params.get('agent') || ''
  const [show, setShow] = useState<Show>({ mode: 'idle' })
  const [caption, setCaption] = useState<string>('')
  const [connected, setConnected] = useState(false)
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Warm up the speech engine (voices load async in Chromium).
    try { window.speechSynthesis?.getVoices() } catch { /* ignore */ }
    if (!agent) return
    const base = agent.replace(/\/$/, '')
    const es = new EventSource(`${base}/canvas-stream`)
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      let evt: { kind: string } & Show & { text?: string }
      try { evt = JSON.parse(e.data) } catch { return }
      if (evt.kind === 'stop') {
        // Interruption — a human started talking; cut the bot's audio now.
        stopTTS()
        setCaption('')
      } else if (evt.kind === 'show') {
        setShow({ mode: evt.mode, title: evt.title, items: evt.items, url: evt.url, text: evt.text })
      } else if (evt.kind === 'say' && evt.text) {
        const sayText: string = evt.text
        // Play agent TTS via Web Audio (off the main thread → smooth even while a
        // page is rendering in "web" mode). Recall's webpage output captures the
        // audio-graph output into the meeting. Fall back to browser speech only if
        // Web Audio / the endpoint fails.
        playTTS(`${base}/tts?text=${encodeURIComponent(sayText)}`).catch(() => speak(sayText))
        setCaption(sayText)
        if (captionTimer.current) clearTimeout(captionTimer.current)
        // Hold the caption roughly as long as it takes to speak (~12 chars/sec).
        captionTimer.current = setTimeout(() => setCaption(''), Math.max(3500, sayText.length * 90))
      }
    }
    return () => { es.close() }
  }, [agent])

  return (
    <main style={{
      width: '100vw', height: '100vh', margin: 0, background: '#0b0e14', color: '#e8ecf4',
      display: 'flex', flexDirection: 'column', fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      overflow: 'hidden',
    }}>
      {/* Brand bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 36px' }}>
        <div style={{ width: 14, height: 14, borderRadius: 999, background: connected ? '#34d399' : '#f59e0b', boxShadow: `0 0 16px ${connected ? '#34d399' : '#f59e0b'}` }} />
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 0.3 }}>Osborn</div>
        <div style={{ fontSize: 15, color: '#7b8494' }}>meeting copilot</div>
      </div>

      {/* Stage */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 56px', minHeight: 0 }}>
        {show.mode === 'idle' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 72, marginBottom: 20 }}>🎧</div>
            <div style={{ fontSize: 34, fontWeight: 600 }}>Listening in</div>
            <div style={{ fontSize: 19, color: '#7b8494', marginTop: 10 }}>Ask me to research, pull something up, or take notes.</div>
          </div>
        )}

        {show.mode === 'text' && (
          <div style={{ textAlign: 'center', maxWidth: 1000 }}>
            {show.title && <div style={{ fontSize: 20, color: '#8b93a3', marginBottom: 14, textTransform: 'uppercase', letterSpacing: 2 }}>{show.title}</div>}
            <div style={{ fontSize: 46, fontWeight: 700, lineHeight: 1.2 }}>{show.text}</div>
          </div>
        )}

        {show.mode === 'notes' && (
          <div style={{ width: '100%', maxWidth: 1040 }}>
            {show.title && <div style={{ fontSize: 30, fontWeight: 700, marginBottom: 24 }}>{show.title}</div>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
              {(show.items || []).map((it, i) => (
                <li key={i} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', fontSize: 26, lineHeight: 1.35 }}>
                  <span style={{ color: '#6366f1', fontWeight: 800 }}>›</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {show.mode === 'link' && (
          <div style={{ textAlign: 'center', maxWidth: 1000 }}>
            <div style={{ fontSize: 20, color: '#8b93a3', marginBottom: 16, textTransform: 'uppercase', letterSpacing: 2 }}>{show.title || 'Pulling up'}</div>
            <div style={{ fontSize: 40, fontWeight: 700, wordBreak: 'break-word' }}>{show.url}</div>
          </div>
        )}

        {show.mode === 'web' && show.url && (
          <iframe src={show.url} title="web" style={{ width: '100%', height: '100%', border: 'none', borderRadius: 14, background: '#fff' }} />
        )}

        {/* Live browser feed — the voice-e2e engine's CDP screencast served as
            MJPEG. This is a VIDEO stream of a REAL browser (not an iframe): shows
            any site (no X-Frame-Options), and it's just an <img> decode so it
            doesn't fight the main thread. `url` is the engine's public feed base;
            we append /stream. This is the "watch it actually browse" surface. */}
        {show.mode === 'stream' && show.url && (
          // FULL-BLEED: the browser feed IS the camera — fill the whole tile
          // (user report 2026-08-01: it rendered as a small inset card,
          // "browser is in background instead of canvas"). Engine emits
          // 1280×720 (16:9, same AR as the camera) so cover ≈ no crop.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`${show.url.replace(/\/$/, '')}/stream`} alt="live browser"
            style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', objectFit: 'cover', borderRadius: 0 }} />
        )}
      </div>

      {/* Live caption of what the bot is saying — overlay, never steals layout */}
      {caption && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 28, zIndex: 2, padding: '0 56px', display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ background: 'rgba(11,14,20,0.82)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: 14, padding: '14px 24px', fontSize: 24, maxWidth: 1100, textAlign: 'center', backdropFilter: 'blur(6px)' }}>
            {caption}
          </div>
        </div>
      )}
    </main>
  )
}

export default function MeetingCanvasPage() {
  return (
    <Suspense fallback={<div style={{ width: '100vw', height: '100vh', background: '#0b0e14' }} />}>
      <CanvasInner />
    </Suspense>
  )
}
