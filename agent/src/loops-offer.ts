/**
 * loops-offer.ts — follow-through (#378) slice 2: when a background slot frees, offer the hub ONE item this
 * process itself refused at the cap (never one read from a ledger file, which any agent can write). It never
 * starts one: the hub asks the user and calls mcp__dispatch__send only on a yes (approval mode applies).
 */
import { dispatchFieldsOk } from './dispatch.js'
import { queuedLoopRecord } from './loops-ledger.js'

const OFFER_REPEAT_MS = 60 * 60 * 1000
const MAX_OFFERS = 2

export function makeOfferer(deps: { hubIdle: () => boolean; now?: () => number }) {
  const items = new Map<string, { project: string; instruction: string; offers: number; last: number }>()
  const now = deps.now ?? Date.now
  const key = (project: string, instruction: string) => queuedLoopRecord(instruction, project).id!
  return {
    /** Remember an item this process queued, with its full (already validated) instruction. */
    add(project: string, instruction: string): void { const k = key(project, instruction); if (dispatchFieldsOk(project, instruction) && !items.has(k)) items.set(k, { project, instruction: instruction.trim(), offers: 0, last: -Infinity }) },
    /** The hub sent it: stop offering. */
    started(project: string, instruction: string): void { items.delete(key(project, instruction)) },
    /** The oldest item due an offer, or null. At most 2 offers per item, an hour apart, never during a live turn. */
    onSlotFree(): { project: string; instruction: string } | null {
      if (!deps.hubIdle()) return null
      const t = now()
      for (const [k, i] of items) {
        if (t - i.last < OFFER_REPEAT_MS) continue
        i.last = t
        if (++i.offers >= MAX_OFFERS) items.delete(k)
        return { project: i.project, instruction: i.instruction }
      }
      return null
    },
  }
}
