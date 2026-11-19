/** A person in the /browser panel: the engine scopes what they can read to their own tabs. */
export const isPersonDriver = (driver: string) => driver.startsWith('person:')

/** Whether `viewer` may see a tab owned by `owner`: a person only their own, every other driver all. */
export const seesTabOf = (owner: string | null | undefined, viewer: string) => !isPersonDriver(viewer) || owner === viewer

/**
 * The engine's tab list as `viewer` may see it: a person sees other drivers'
 * tabs (so they can be taken over) without their URL; everyone else sees all.
 */
export function tabsFor<P>(pages: P[], ownerOf: (p: P) => string | null | undefined, urlOf: (p: P) => string, viewer: string) {
  return pages.map((p, i) => ({ i, url: seesTabOf(ownerOf(p), viewer) ? urlOf(p) : '', owner: ownerOf(p) ?? null }))
}

/**
 * Who an engine event is about, so /events can scope it per caller.
 *
 * Owners come from the payload's tab fields, read when the event fires (tab
 * indexes shift later): `tab` (an index), `task.tab.owner`, `activeTab.owner`,
 * and `owner` / `by` / `prevOwner`. An event with none of them (engine status,
 * room, brain) or only about unowned tabs has no owners and is public.
 */
export function eventOwners(payload: Record<string, any>, ownerAtIndex: (i: number) => string | null | undefined): string[] {
  const found = [
    typeof payload.tab === 'number' ? ownerAtIndex(payload.tab) : undefined,
    payload.task?.tab?.owner, payload.activeTab?.owner, payload.owner, payload.by, payload.prevOwner,
  ]
  return [...new Set(found.filter((o): o is string => typeof o === 'string' && o.length > 0))]
}

/**
 * A person in the /browser panel (driver `person:<email>`) gets public events and
 * events about their own tabs; every other driver gets everything, as before.
 */
export function eventVisibleTo(owners: string[], driver: string): boolean {
  return !isPersonDriver(driver) || owners.length === 0 || owners.includes(driver)
}
