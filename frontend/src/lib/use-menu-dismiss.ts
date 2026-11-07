'use client'

import { useEffect, useRef, type RefObject } from 'react'
import { isDismissKey, isOutsideTarget, type DismissReason } from './menu-dismiss'

/**
 * Close an open menu on Escape or on a pointerdown outside it.
 *
 * - `containers`: refs whose subtree counts as "inside" (the menu AND its
 *   toggle; a wrapper that holds both is enough). Pointerdowns inside are
 *   ignored so the toggle's own onClick can close the menu.
 * - `onDismiss(reason)`: called once per dismissing event. The caller decides
 *   what to close (e.g. a nested confirm first on Escape).
 * - `returnFocusTo`: focused after an Escape dismissal so keyboard users land
 *   back on the toggle. Not used for outside clicks (that would steal focus
 *   from what the user clicked).
 *
 * Listeners are attached in the capture phase so a child that stops
 * propagation can't swallow Escape or the outside pointerdown. Use this
 * instead of a full-screen backdrop: a backdrop that sits above the toggle
 * blocks re-clicking it.
 */
export function useMenuDismiss(
  open: boolean,
  onDismiss: (reason: DismissReason) => void,
  containers: ReadonlyArray<RefObject<HTMLElement | null>>,
  returnFocusTo?: RefObject<HTMLElement | null>,
) {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const containersRef = useRef(containers)
  containersRef.current = containers
  const focusRef = useRef(returnFocusTo)
  focusRef.current = returnFocusTo

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (!isDismissKey(e.key)) return
      onDismissRef.current('escape')
      const el = focusRef.current?.current
      if (el) { try { el.focus() } catch { /* detached */ } }
    }
    const onPointer = (e: PointerEvent) => {
      const nodes = containersRef.current.map(r => r.current)
      if (isOutsideTarget(e.target as Node | null, nodes)) onDismissRef.current('outside')
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [open])
}
