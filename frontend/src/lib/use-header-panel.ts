'use client'

import { useEffect, useRef, type RefObject } from 'react'

/**
 * useHeaderPanel — dismissal + mutual exclusion for header dropdowns/menus.
 *
 * Reuses the event-bus approach proven in VoiceRoom.tsx's `usePanelExclusive`
 * (commit e7d5a66, "header panels are mutually exclusive"): opening any
 * registered panel broadcasts its id on a window CustomEvent and every other
 * panel listening on the same event closes itself — so only ONE header panel
 * is ever open and two can't stack.
 *
 * It also adds the behaviours those header menus were missing (the
 * project-card menu and New-Project form already had Esc): Escape-to-close,
 * and — when a wrapper `ref` is supplied — click-outside-to-close plus
 * Tab-away-to-close (issue #113: focus leaving the menu via Tab/Shift-Tab
 * dismisses it, matching Esc and click-outside). A menu that already covers
 * outside clicks with its own full-screen backdrop can omit the ref and still
 * get Esc + mutual exclusion.
 */
const HEADER_PANEL_EVT = 'vn:header-panel-open'

export function useHeaderPanel(
  id: string,
  open: boolean,
  setOpen: (v: boolean) => void,
  ref?: RefObject<HTMLElement | null>,
) {
  // Keep the latest setter without re-subscribing listeners every render.
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen

  // Mutual exclusion: close when ANOTHER panel announces it just opened.
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent).detail !== id) setOpenRef.current(false)
    }
    window.addEventListener(HEADER_PANEL_EVT, onOther)
    return () => window.removeEventListener(HEADER_PANEL_EVT, onOther)
  }, [id])

  // Announce our own open so every other panel closes.
  useEffect(() => {
    if (!open) return
    try { window.dispatchEvent(new CustomEvent(HEADER_PANEL_EVT, { detail: id })) } catch { /* no-op */ }
  }, [open, id])

  // Esc-to-close, and (with a ref) click-outside-to-close and Tab-away-to-close
  // — only while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenRef.current(false) }
    const onPointer = (e: Event) => {
      const el = ref?.current
      if (el && !el.contains(e.target as Node)) setOpenRef.current(false)
    }
    // Issue #113: close when keyboard focus leaves the menu (Tab / Shift-Tab).
    // focusout bubbles, so the element losing focus is e.target and the one
    // gaining it is e.relatedTarget. We close only when focus was inside the
    // menu and moves to a real element outside it — a null relatedTarget
    // (window blur, focus falling to <body>) is ignored so the menu isn't
    // closed spuriously, and focus moving between items inside stays open.
    const onFocusOut = (e: FocusEvent) => {
      const el = ref?.current
      if (!el) return
      const from = e.target as Node | null
      const to = e.relatedTarget as Node | null
      if (from && el.contains(from) && to && !el.contains(to)) setOpenRef.current(false)
    }
    window.addEventListener('keydown', onKey)
    if (ref) {
      document.addEventListener('mousedown', onPointer)
      document.addEventListener('focusout', onFocusOut)
    }
    return () => {
      window.removeEventListener('keydown', onKey)
      if (ref) {
        document.removeEventListener('mousedown', onPointer)
        document.removeEventListener('focusout', onFocusOut)
      }
    }
  }, [open, ref])
}
