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
