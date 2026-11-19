/** A person in the /browser panel: the engine scopes what they can read to their own tabs. */
export const isPersonDriver = (driver: string) => driver.startsWith('person:')

/** Whether `viewer` may see a tab owned by `owner`: a person only their own, every other driver all. */
export const seesTabOf = (owner: string | null | undefined, viewer: string) => !isPersonDriver(viewer) || owner === viewer

/** An owner id as `viewer` may see it: a person sees another person only as "person"; agent ids stay. */
export const ownerSeenBy = (owner: string | null | undefined, viewer: string): string | null =>
  !owner ? null : isPersonDriver(viewer) && isPersonDriver(owner) && owner !== viewer ? 'person' : owner

/**
 * Whether a person may claim, switch to or take over a tab: never one another
 * person owns, nor one in another person's browser profile (their sign-ins),
 * even after it was released. Agents are not limited here.
 */
export const personMayTake = (viewer: string, owner: string | null | undefined, profile: string | null | undefined) =>
  !isPersonDriver(viewer) || ((!owner || !isPersonDriver(owner) || owner === viewer) && (!profile || !isPersonDriver(profile) || profile === viewer.toLowerCase()))

/**
 * The engine's tab list as `viewer` may see it: a person sees other drivers'
 * tabs (so they can be taken over) without their URL, and other people as "person".
 */
export function tabsFor<P>(pages: P[], ownerOf: (p: P) => string | null | undefined, urlOf: (p: P) => string, viewer: string) {
  return pages.map((p, i) => ({ i, url: seesTabOf(ownerOf(p), viewer) ? urlOf(p) : '', owner: ownerSeenBy(ownerOf(p), viewer) }))
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
