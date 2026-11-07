/**
 * tab-guard.ts — one controlling chat tab per browser (bug 619af155,
 * frontend minimum; the full listen-only model is lane L12).
 *
 * The agent makes the newest joiner the controller and rebuilds the session
 * for it, so a second tab silently stole the session and triggered a fresh
 * greeting. The provider now holds a Web Lock while it controls the session.
 * A tab that cannot get the lock stays out of the room (no join, no greeting,
 * no mic, no send) until the user chooses "Take over", which steals the lock;
 * the previous holder learns it was stolen and drops its room.
 * Pure state machine; the provider does the Web Locks calls.
 */

export const TAB_LOCK_NAME = 'vn-chat-controller'

export type TabRole = 'probing' | 'active' | 'standby' | 'taking' | 'taken-over'

export type TabGuardEvent =
  | { type: 'acquired' }
  | { type: 'unavailable' }
  | { type: 'unsupported' }
  | { type: 'take-over' }
  | { type: 'stolen' }

export function tabGuardReducer(role: TabRole, ev: TabGuardEvent): TabRole {
  switch (ev.type) {
    case 'acquired':
    case 'unsupported':
      return 'active'
    case 'unavailable':
      return role === 'probing' || role === 'taking' ? 'standby' : role
    case 'take-over':
      return role === 'standby' || role === 'taken-over' ? 'taking' : role
    case 'stolen':
      return role === 'active' ? 'taken-over' : role
    default:
      return role
  }
}

/** Connect to the room exactly when this tab becomes the controller. */
export function shouldConnectOnTransition(prev: TabRole, next: TabRole): boolean {
  return next === 'active' && prev !== 'active'
}

/** Mic and send belong to the controlling tab only. */
export function controlsEnabled(role: TabRole): boolean {
  return role === 'active'
}

export function tabGuardCopy(role: TabRole): { title: string; body: string; action: string } | null {
  if (role === 'standby' || role === 'taking') {
    return {
      title: 'This session is active in another tab',
      body: 'Only one tab can talk to Osborn at a time. Take over to continue here; the other tab will stop.',
      action: 'Take over',
    }
  }
  if (role === 'taken-over') {
    return {
      title: 'This session moved to another tab',
      body: 'You took over in another tab, so this one stopped. Take over to continue here instead.',
      action: 'Take over',
    }
  }
  return null
}
