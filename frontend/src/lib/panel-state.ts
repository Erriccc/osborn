// Right-side living panel: open/closed, active tab and width, persisted in
// localStorage under `vn-panel` (build plan L4). Pure parse/serialize so a
// corrupt or old value can never break the voice screen.

export const PANEL_STORAGE_KEY = 'vn-panel'
export const MIN_PANEL_WIDTH_PCT = 28
export const MAX_PANEL_WIDTH_PCT = 70

export interface PanelState {
  open: boolean
  tab: string
  /** Desktop drawer width as a percent of the room row. */
  widthPct: number
}

export const DEFAULT_PANEL_STATE: Readonly<PanelState> = Object.freeze({ open: false, tab: 'outputs', widthPct: 45 })

export function clampPanelWidth(n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_PANEL_STATE.widthPct
  return Math.min(MAX_PANEL_WIDTH_PCT, Math.max(MIN_PANEL_WIDTH_PCT, Math.round(n)))
}

export function parsePanelState(raw: string | null | undefined): PanelState {
  const base: PanelState = { ...DEFAULT_PANEL_STATE }
  if (!raw) return base
  let v: unknown
  try { v = JSON.parse(raw) } catch { return base }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return base
  const o = v as Record<string, unknown>
  if (typeof o.open === 'boolean') base.open = o.open
  if (typeof o.tab === 'string' && o.tab) base.tab = o.tab
  if (typeof o.widthPct === 'number') base.widthPct = clampPanelWidth(o.widthPct)
  return base
}

export function serializePanelState(s: PanelState): string {
  return JSON.stringify({ open: !!s.open, tab: s.tab, widthPct: clampPanelWidth(s.widthPct) })
}
