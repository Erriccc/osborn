// Tab registry for the right-side living panel (build plan L4).
// A tab registers itself once at module load; RightPanel reads the registry, so
// later lanes (Activity timeline L5, Preview, Browser L7, Diagram L11) add a tab
// by calling registerTab() from their own module and importing it in
// ./builtin-tabs.ts, without editing VoiceRoom.tsx or RightPanel.tsx.
// Kept free of runtime React imports so it can be unit tested with tsx.
import type { ComponentType, ReactNode } from 'react'
import type { PanelData } from './PanelDataContext'

export const DEFAULT_TAB_ID = 'outputs'

export interface PanelTabProps {
  /** True while this tab is the visible tab of an open panel. */
  active: boolean
}

export interface PanelTabDef {
  id: string
  label: string
  /** Small icon for the tab strip (an element or a render function). */
  icon?: ReactNode | (() => ReactNode)
  component: ComponentType<PanelTabProps>
  /** Unread count or short label shown on the tab (and on the panel toggle)
   *  while the tab is not visible. Return null/0 for none. */
  badge?: (data: PanelData) => number | string | null | undefined
  /** Lower sorts first; tabs without an order keep registration order after
   *  ordered ones with a negative order and before ones with a positive order. */
  order?: number
}

let tabs: PanelTabDef[] = []

export function registerTab(def: PanelTabDef): boolean {
  // Components may be functions or objects (React.memo / forwardRef).
  const c = def?.component as unknown
  const validComponent = typeof c === 'function' || (typeof c === 'object' && c !== null)
  if (!def || typeof def.id !== 'string' || !def.id || !validComponent) {
    console.warn('[panel] registerTab: invalid tab definition', def && def.id)
    return false
  }
  if (tabs.some((t) => t.id === def.id)) {
    console.warn(`[panel] registerTab: duplicate tab id "${def.id}" rejected`)
    return false
  }
  tabs = [...tabs, def]
  return true
}

/** Registered tabs in display order. Returns a frozen snapshot. */
export function getTabs(): readonly PanelTabDef[] {
  const indexed = tabs.map((t, i) => ({ t, i }))
  indexed.sort((a, b) => (a.t.order ?? 0) - (b.t.order ?? 0) || a.i - b.i)
  return Object.freeze(indexed.map((x) => x.t))
}

export function getTab(id: string): PanelTabDef | undefined {
  return tabs.find((t) => t.id === id)
}

/** A stored or requested tab id that no longer exists falls back to Outputs
 *  (or the first tab if Outputs is not registered). */
export function resolveTabId(id: string | null | undefined): string {
  if (id && tabs.some((t) => t.id === id)) return id
  if (tabs.some((t) => t.id === DEFAULT_TAB_ID)) return DEFAULT_TAB_ID
  return getTabs()[0]?.id ?? DEFAULT_TAB_ID
}

/** Test-only: clear every registration. */
export function _resetRegistryForTests(): void {
  tabs = []
}
