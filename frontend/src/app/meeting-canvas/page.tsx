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
  mode: 'idle' | 'notes' | 'link' | 'web' | 'text'
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
      if (evt.kind === 'show') {
        setShow({ mode: evt.mode, title: evt.title, items: evt.items, url: evt.url, text: evt.text })
      } else if (evt.kind === 'say' && evt.text) {
        // Play agent-generated TTS as a real <audio> element — Recall's webpage
        // output pipes media-element audio into the meeting (speechSynthesis is
        // NOT captured). Fall back to browser speech if the endpoint/autoplay fails.
        try {
          const a = new Audio(`${base}/tts?text=${encodeURIComponent(evt.text)}`)
          a.play().catch(() => speak(evt.text))
        } catch { speak(evt.text) }
        setCaption(evt.text)
        if (captionTimer.current) clearTimeout(captionTimer.current)
        // Hold the caption roughly as long as it takes to speak (~12 chars/sec).
        captionTimer.current = setTimeout(() => setCaption(''), Math.max(3500, evt.text.length * 90))
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
      </div>

      {/* Live caption of what the bot is saying */}
      {caption && (
        <div style={{ padding: '0 56px 40px', display: 'flex', justifyContent: 'center' }}>
          <div style={{ background: 'rgba(99,102,241,0.16)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: 14, padding: '16px 26px', fontSize: 24, maxWidth: 1100, textAlign: 'center' }}>
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
