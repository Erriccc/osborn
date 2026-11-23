/**
 * loops-offer.ts — follow-through (#378) slice 2: when a background slot frees, offer the hub ONE queued
 * item (never start it). getSpokeReport words the offer; the hub asks the user, and on a yes it calls
 * mcp__dispatch__send (approval mode applies), which records `started`.
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { listLedgers, nextQueued, readLoopRecordsAt, type LoopItem } from './loops-ledger.js'
import { dispatchFieldsOk } from './dispatch.js'

const OFFER_REPEAT_MS = 60 * 60 * 1000

/**
 * The oldest open queued item across ledgers of OTHER project folders that still exist. The ledger is model-written
 * data, so an item the dispatch tool itself would refuse (control or bidi characters, too long) is never offered.
 */
function findQueuedOffer(hubCwd: string | undefined, skip: (id: string) => boolean): { project: string; item: LoopItem } | undefined {
  const found: Array<{ project: string; item: LoopItem }> = []
  for (const l of listLedgers()) {
    if (!l.cwd || l.cwd === hubCwd || !existsSync(l.cwd)) continue
    const item = nextQueued(readLoopRecordsAt(l.path))
    const project = basename(l.cwd)
    if (item && !skip(item.id) && dispatchFieldsOk(project, item.instruction)) found.push({ project, item })
  }
  return found.sort((a, b) => a.item.at.localeCompare(b.item.at))[0]
}

/** One offer per slot-free event, never the same item twice within an hour, never during a live hub turn. */
export function makeOfferer(deps: { hubCwd: () => string | undefined; hubIdle: () => boolean; now?: () => number }) {
  const offeredAt = new Map<string, number>()
  const now = deps.now ?? Date.now
  return {
    /** The item to offer on a slot-free event, or null. Records the offer. */
    onSlotFree(): { project: string; instruction: string } | null {
      if (!deps.hubIdle()) return null
      const t = now()
      const o = findQueuedOffer(deps.hubCwd(), (id) => t - (offeredAt.get(id) ?? -Infinity) < OFFER_REPEAT_MS)
      if (!o) return null
      offeredAt.set(o.item.id, t)
      return { project: o.project, instruction: o.item.instruction! }
    },
  }
}
