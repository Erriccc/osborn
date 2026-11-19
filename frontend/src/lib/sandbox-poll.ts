/**
 * What one /api/sandbox status poll says about the user's machine, or null when
 * it says nothing new: a failed request, an error reply (401/409/5xx), or the
 * server's cached DB row after its Fly lookup failed (`cached`). The dashboard
 * and settings polls keep their last state on null, so a single slow or failed
 * poll never flips the machine from ready to asleep and back.
 */
export type SandboxPoll = { available: boolean; sandbox: { id: string; status: string; previewUrl?: string | null } | null }

export function readSandboxPoll(ok: boolean, d: any): SandboxPoll | null {
  if (!ok || !d || typeof d !== 'object' || d.cached) return null
  return { available: !!d.available, sandbox: d.sandbox ?? null }
}

export async function pollSandbox(): Promise<SandboxPoll | null> {
  try {
    const r = await fetch('/api/sandbox', { cache: 'no-store' })
    return readSandboxPoll(r.ok, await r.json().catch(() => null))
  } catch {
    return null
  }
}

/** The page state a poll result writes (the dashboard's and settings' setters). */
export type SandboxPollSetters = {
  setSandboxAvailable: (v: boolean) => void
  setSandboxId: (v: string) => void
  setSandboxStatus: (v: string | null) => void
  setAgentUrl: (v: string) => void
  setAgentOnline: (v: boolean) => void
}

export function applySandboxPoll(d: SandboxPoll, set: SandboxPollSetters): void {
  set.setSandboxAvailable(d.available)
  if (d.sandbox) {
    set.setSandboxId(d.sandbox.id)
    set.setSandboxStatus(d.sandbox.status)
    if (d.sandbox.previewUrl) set.setAgentUrl(d.sandbox.previewUrl)
    set.setAgentOnline(d.sandbox.status === 'running')
  } else {
    set.setSandboxStatus(null)
    set.setAgentOnline(false)
  }
}

/** User-facing text for /api/sandbox ownership failures (409 conflict / 503 unverifiable). */
export function machineIssueText(status: number): string {
  return status === 409
    ? 'This machine is claimed by another account. Please contact support.'
    : "We couldn't verify your machine right now. Please retry in a moment."
}
