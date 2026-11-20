/** Resolve `true` once the promise settles (fulfilled or rejected), `false` if `ms` pass first. Never rejects. */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms) })
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Close a session, but never wait longer than `closeMs` (default 15 s). */
export async function closeSessionBounded(sess: any, opts: { closeMs?: number } = {}): Promise<void> {
  if (!(await settleWithin(sess.close(), opts.closeMs ?? 15000))) {
    console.warn('⚠️ session close timed out — continuing')
    try { console.warn('   session host attached after timeout:', !!(sess as any)?.sessionHost) } catch {}
  }
}
