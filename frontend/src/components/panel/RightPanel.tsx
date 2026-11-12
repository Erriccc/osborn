'use client'

// Right-side living panel shell (build plan L4). Desktop (xl+, >=1280px): an
// inline drawer beside the chat (default 45% of the row, drag/arrow-key
// resizable). Below xl (phone + tablet): a bottom-sheet OVERLAY that sits ABOVE
// the mic / hang-up strip when it exists (phone) and otherwise at the viewport
// bottom (tablet), so the conversation stays full width instead of being
// crushed into a three-column squeeze (issue #118).
// Never a full-screen takeover, never a backdrop: the session stays visible.
// Open/tab/width persist via usePanelState (localStorage `vn-panel`).
import { useCallback, useEffect, useRef, useState } from 'react'
import './builtin-tabs'
import { getTabs, resolveTabId, type PanelTabDef } from './registry'
import { usePanelData, type PanelData } from './PanelDataContext'
import { PANEL_SHEET_QUERY } from '@/lib/panel-state'

/**
 * Element (in VoiceRoom) whose top edge the sheet must stay above: the bottom
 * composer area, which exists at every width (the phone-only mic strip inside
 * it does not, so anchoring on that left the sheet over the tablet composer).
 */
export const PANEL_ANCHOR_ATTR = 'data-panel-anchor'

function renderIcon(icon: PanelTabDef['icon']) {
  if (!icon) return null
  return typeof icon === 'function' ? (icon as () => React.ReactNode)() : icon
}

function badgeOf(tab: PanelTabDef, data: PanelData): number | string | null {
  try {
    const b = tab.badge?.(data)
    return b === 0 || b === '' || b == null ? null : b
  } catch { return null }
}

function isTabVisible(data: PanelData, id: string): boolean {
  return data.panel.open && resolveTabId(data.panel.tab) === id
}

/** Sum of numeric badges of tabs the user cannot currently see. */
export function useHiddenBadgeCount(): number {
  const data = usePanelData()
  let n = 0
  for (const t of getTabs()) {
    if (isTabVisible(data, t.id)) continue
    const b = badgeOf(t, data)
    if (typeof b === 'number') n += b
  }
  return n
}

/** Header toggle for the panel; shows unread counts of hidden tabs. */
export function PanelToggleButton({ className = '' }: { className?: string }) {
  const data = usePanelData()
  const hidden = useHiddenBadgeCount()
  const { open, togglePanel } = data.panel
  return (
    <button onClick={() => togglePanel()} aria-pressed={open} data-testid="panel-toggle"
      aria-label={open ? 'Close side panel' : hidden ? `Open outputs, ${hidden} new` : 'Open outputs'}
      title={open ? 'Close side panel' : 'Outputs — what Osborn made'}
      className={`relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all ${
        open ? 'bg-amber-500/20 text-amber-300' : 'text-gray-500 hover:bg-gray-800/60 hover:text-gray-200'
      } ${className}`}>
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" /><path strokeLinecap="round" d="M14 4v16" />
      </svg>
      <span>Outputs</span>
      {hidden > 0 && (
        <span data-testid="panel-toggle-badge" className="min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-amber-500 text-gray-900 text-[10px] font-bold leading-[1.1rem] text-center">
          {hidden > 99 ? '99+' : hidden}
        </span>
      )}
    </button>
  )
}

function useMobileSheetBottom(enabled: boolean): number {
  const [bottom, setBottom] = useState(0)
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    // Overlay for everything below the xl desktop breakpoint (phone + tablet).
    // PANEL_SHEET_QUERY is the same breakpoint as the aside's `xl:` classes.
    const mq = window.matchMedia(PANEL_SHEET_QUERY)
    const measure = () => {
      if (!mq.matches) { setBottom(0); return }
      const anchor = document.querySelector(`[${PANEL_ANCHOR_ATTR}]`) as HTMLElement | null
      // Only if the anchor is missing entirely (another surface, SSR, a future
      // layout) does the sheet fall back to the plain viewport bottom.
      if (!anchor || anchor.getClientRects().length === 0) { setBottom(0); return }
      const top = anchor.getBoundingClientRect().top
      setBottom(Math.max(0, Math.round(window.innerHeight - top)))
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    const anchor = document.querySelector(`[${PANEL_ANCHOR_ATTR}]`)
    if (ro && anchor) ro.observe(anchor)
    window.addEventListener('resize', measure)
    mq.addEventListener?.('change', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
      mq.removeEventListener?.('change', measure)
    }
  }, [enabled])
  return bottom
}

export function RightPanel() {
  const data = usePanelData()
  const { open, tab, widthPct, setTab, closePanel, setWidthPct } = data.panel
  const asideRef = useRef<HTMLElement>(null)
  const [tall, setTall] = useState(false)
  const sheetBottom = useMobileSheetBottom(open)

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    const row = asideRef.current?.parentElement
    if (!row) return
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture?.(e.pointerId)
    const move = (ev: PointerEvent) => {
      const r = row.getBoundingClientRect()
      if (r.width <= 0) return
      setWidthPct(((r.right - ev.clientX) / r.width) * 100)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [setWidthPct])

  if (!open) return null
  const tabs = getTabs()
  const activeId = resolveTabId(tab)
  const active = tabs.find((t) => t.id === activeId)
  const Active = active?.component

  const style = {
    '--vn-panel-w': `${widthPct}%`,
    '--vn-sheet-bottom': `${sheetBottom}px`,
    '--vn-sheet-h': tall ? `calc(100dvh - ${sheetBottom}px - 4rem)` : `min(60dvh, calc(100dvh - ${sheetBottom}px - 4rem))`,
  } as React.CSSProperties

  return (
    <aside ref={asideRef} aria-label="Side panel" data-testid="right-panel" style={style}
      className="fixed inset-x-0 z-40 bottom-[var(--vn-sheet-bottom)] h-[var(--vn-sheet-h)] rounded-t-2xl border-t border-gray-700 shadow-2xl
        xl:relative xl:inset-auto xl:bottom-auto xl:z-auto xl:h-auto xl:w-[var(--vn-panel-w)] xl:shrink-0 xl:rounded-xl xl:border xl:border-gray-800/50 xl:shadow-none
        flex flex-col bg-gray-900 overflow-hidden">
      {/* Desktop resize handle (left edge) */}
      <div role="separator" aria-orientation="vertical" aria-label="Resize side panel" tabIndex={0}
        aria-valuenow={widthPct} aria-valuemin={28} aria-valuemax={70}
        onPointerDown={onResizeStart}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); setWidthPct(widthPct + 2) }
          if (e.key === 'ArrowRight') { e.preventDefault(); setWidthPct(widthPct - 2) }
        }}
        className="hidden xl:block absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-20 hover:bg-amber-500/30 focus:bg-amber-500/40 focus:outline-none" />
      {/* Mobile grab handle: toggles short / tall sheet */}
      <button onClick={() => setTall((v) => !v)} aria-label={tall ? 'Shrink panel' : 'Expand panel'}
        className="xl:hidden w-full pt-2 pb-1 flex justify-center">
        <span className="w-10 h-1 rounded-full bg-gray-700" />
      </button>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-800 shrink-0">
        <div role="tablist" aria-label="Side panel tabs" className="flex items-center gap-1 min-w-0 overflow-x-auto">
          {tabs.map((t) => {
            const isActive = t.id === activeId
            const b = isActive ? null : badgeOf(t, data)
            return (
              <button key={t.id} role="tab" aria-selected={isActive} onClick={() => setTab(t.id)} data-testid={`panel-tab-${t.id}`}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}>
                {renderIcon(t.icon)}
                {t.label}
                {b != null && (
                  <span className="min-w-[1rem] h-4 px-1 rounded-full bg-amber-500 text-gray-900 text-[10px] font-bold leading-4 text-center">{b}</span>
                )}
              </button>
            )
          })}
        </div>
        <button onClick={closePanel} aria-label="Close side panel" title="Close"
          className="ml-auto p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800 shrink-0">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden" role="tabpanel">
        {Active ? <Active active /> : (
          <div className="p-6 text-xs text-gray-500">Nothing to show.</div>
        )}
      </div>
    </aside>
  )
}
