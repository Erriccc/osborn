/** A person in the /browser panel: the engine scopes what they can read to their own tabs. */
export const isPersonDriver = (driver: string) => driver.startsWith('person:')

/**
 * One spelling per driver, used for every ownership, working and profile check:
 * trimmed, and a person's email lowercased, so `person:A@x.com` and
 * `person:a@x.com` are the same driver. The `person:` prefix itself is matched
 * as written (as isPersonDriver does), so agent ids are never changed. No id is
 * the default driver.
 */
export const canonicalDriverId = (raw: unknown): string => {
  const d = String(raw ?? '').trim().slice(0, 200)
  if (!d) return 'default'
  return isPersonDriver(d) ? d.toLowerCase() : d
}

/**
 * THE RULE for people: the only tab a person may see or act on is one they own.
 * Unowned tabs (tab 0, the voice room, included) are invisible and untouchable
 * to them. Every person check in the engine goes through this.
 */
export const personOwns = (owner: string | null | undefined, driver: string) => !!owner && owner === driver

/** Whether `viewer` may see a tab owned by `owner`: a person only their own, every other driver all. */
export const seesTabOf = (owner: string | null | undefined, viewer: string) => !isPersonDriver(viewer) || personOwns(owner, viewer)

/** An owner id as `viewer` may see it: a person sees another person only as "person"; agent ids stay. */
export const ownerSeenBy = (owner: string | null | undefined, viewer: string): string | null =>
  !owner ? null : isPersonDriver(viewer) && isPersonDriver(owner) && owner !== viewer ? 'person' : owner

/**
 * Whether a person may claim, switch to or take over a tab: their own, or an
 * agent's tab (take control). Never tab 0 (the voice room), even after an agent
 * claimed it; never an unowned tab, never one
 * another person owns, and never one in another person's browser profile (their
 * sign-ins). Agents are not limited here.
 */
export const personMayTake = (viewer: string, index: number, owner: string | null | undefined, profile: string | null | undefined) =>
  !isPersonDriver(viewer) || (index > 0 && (personOwns(owner, viewer) || (!!owner && !isPersonDriver(owner))) && (!profile || !isPersonDriver(profile) || profile === viewer.toLowerCase()))

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
 * indexes shift later): `tab` (an index), `task.tab`, `activeTab`, and the
 * `owner` / `by` / `prevOwner` keys. Each field present counts, an unowned tab
 * as null. An event with none of them (engine status, room, brain) has no tab
 * context: an empty list.
 */
export function eventOwners(payload: Record<string, any>, ownerAtIndex: (i: number) => string | null | undefined): Array<string | null> {
  const found: Array<string | null | undefined> = []
  if (typeof payload.tab === 'number') found.push(ownerAtIndex(payload.tab))
  if (payload.task?.tab) found.push(payload.task.tab.owner)
  if (payload.activeTab) found.push(payload.activeTab.owner)
  for (const k of ['owner', 'by', 'prevOwner']) if (k in payload) found.push(payload[k])
  return [...new Set(found.map((o) => (typeof o === 'string' && o ? o : null)))]
}

/**
 * Every driver but a person gets every event, as before. A person gets an event
 * only when it has no tab context at all, or when every tab owner in it is them.
 */
export function eventVisibleTo(owners: Array<string | null>, driver: string): boolean {
  return !isPersonDriver(driver) || owners.every((o) => personOwns(o, driver))
}
