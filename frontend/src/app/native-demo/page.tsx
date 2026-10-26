'use client'

/**
 * /native-demo — a THROWAWAY comparison screen (not linked anywhere, noindex).
 *
 * Purpose: let the founder feel "native-styled web" (Path A) on the real phone
 * next to the current /dashboard, before deciding Capacitor-polish vs a React
 * Native rewrite. This is the SAME web stack (React + Tailwind in the WKWebView)
 * — the point is that HTML can be made to feel iOS-native with: iOS large-title
 * nav, inset-grouped lists, system font, pressed-state touch feedback, momentum
 * scroll, safe-area insets, and Capacitor haptics. Nothing here touches the real
 * dashboard; delete this route once the direction is chosen.
 */

import { useState } from 'react'

// Fire a native haptic tap when running inside the Capacitor shell. In plain
// Safari the bridge is absent and this is a no-op — which itself demonstrates
// the one thing a webview adds over a bookmark.
function haptic(style: 'light' | 'medium' = 'light') {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: { Haptics?: { impact?: (o: { style: string }) => void } } } }).Capacitor
    cap?.Plugins?.Haptics?.impact?.({ style: style.toUpperCase() })
  } catch { /* not in shell */ }
}

const SESSIONS = [
  { id: '1', title: 'Mobile iOS + watchOS shell', sub: 'osborn · 2m ago', glyph: '📱' },
  { id: '2', title: 'Pushover + ntfy wrist bridge', sub: 'osborn · 1h ago', glyph: '⌚️' },
  { id: '3', title: 'Marketing V2 redesign', sub: 'voice-native · yesterday', glyph: '🎨' },
  { id: '4', title: 'LiveKit reconnect grace', sub: 'osborn · yesterday', glyph: '🔌' },
]

const PROJECTS = [
  { id: 'p1', name: 'osborn', count: 18, glyph: '🗂️' },
  { id: 'p2', name: 'voice-native', count: 7, glyph: '🌐' },
]

export default function NativeDemo() {
  const [tab, setTab] = useState<'sessions' | 'library' | 'settings'>('sessions')

  return (
    <div
      className="min-h-dvh bg-black text-white flex flex-col"
      style={{
        // iOS system font stack — the single biggest "feels native" lever.
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif',
        // Honour the notch / home indicator.
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      {/* iOS large-title nav bar */}
      <header className="px-4 pt-2 pb-3">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-white/50">Voice Native</div>
          <button
            onClick={() => haptic('light')}
            className="w-9 h-9 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center text-[17px] transition-colors"
            aria-label="Account"
          >
            👤
          </button>
        </div>
        <h1 className="text-[34px] font-bold tracking-tight mt-1 leading-none">Sessions</h1>
      </header>

      {/* Scrollable content — momentum scroll, inset-grouped lists */}
      <main
        className="flex-1 overflow-y-auto px-4 pb-4"
        style={{ WebkitOverflowScrolling: 'touch' as never }}
      >
        {/* Primary action — iOS filled button */}
        <button
          onClick={() => haptic('medium')}
          className="w-full h-[50px] rounded-2xl bg-blue-500 active:bg-blue-600 active:scale-[0.98] transition-all text-[17px] font-semibold flex items-center justify-center gap-2 mb-6"
        >
          <span className="text-[20px]">＋</span> New Session
        </button>

        {/* Recent — inset-grouped list */}
        <SectionLabel>RECENT</SectionLabel>
        <Group>
          {SESSIONS.map((s, i) => (
            <Row key={s.id} divider={i < SESSIONS.length - 1} onTap={() => haptic('light')}>
              <span className="text-[22px] mr-3">{s.glyph}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[17px] leading-tight truncate">{s.title}</div>
                <div className="text-[13px] text-white/45 truncate">{s.sub}</div>
              </div>
              <Chevron />
            </Row>
          ))}
        </Group>

        {/* Projects */}
        <SectionLabel>PROJECTS</SectionLabel>
        <Group>
          {PROJECTS.map((p, i) => (
            <Row key={p.id} divider={i < PROJECTS.length - 1} onTap={() => haptic('light')}>
              <span className="text-[22px] mr-3">{p.glyph}</span>
              <div className="flex-1 text-[17px]">{p.name}</div>
              <span className="text-[15px] text-white/40 mr-2">{p.count}</span>
              <Chevron />
            </Row>
          ))}
        </Group>

        <p className="text-[13px] text-white/30 text-center mt-8 px-6">
          This is the web stack styled to feel native — iOS font, grouped lists,
          pressed-state taps, haptics, safe areas. Compare to /dashboard.
        </p>
      </main>

      {/* iOS tab bar — frosted, safe-area bottom inset */}
      <nav
        className="border-t border-white/10 bg-black/80 backdrop-blur-xl flex items-stretch"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {([
          ['sessions', '💬', 'Sessions'],
          ['library', '📚', 'Library'],
          ['settings', '⚙️', 'Settings'],
        ] as const).map(([key, glyph, label]) => (
          <button
            key={key}
            onClick={() => { setTab(key); haptic('light') }}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 active:opacity-60 transition-opacity"
          >
            <span className={`text-[22px] ${tab === key ? '' : 'grayscale opacity-50'}`}>{glyph}</span>
            <span className={`text-[10px] ${tab === key ? 'text-blue-400' : 'text-white/40'}`}>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] font-medium text-white/40 px-4 mb-2 mt-2">{children}</div>
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl bg-white/[0.07] overflow-hidden mb-4">{children}</div>
}

function Row({ children, divider, onTap }: { children: React.ReactNode; divider?: boolean; onTap?: () => void }) {
  return (
    <button
      onClick={onTap}
      className="w-full flex items-center px-4 py-3 text-left active:bg-white/10 transition-colors"
      style={divider ? { boxShadow: 'inset 0 -0.5px 0 rgba(255,255,255,0.08)' } : undefined}
    >
      {children}
    </button>
  )
}

function Chevron() {
  return <span className="text-white/25 text-[18px] ml-1">›</span>
}
