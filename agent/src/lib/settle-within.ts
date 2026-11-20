/** Resolve with the promise's outcome, or `false` once `ms` pass. Never rejects. */
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
  if (!(await settleWithin(sess.close(), opts.closeMs ?? 15000))) console.warn('⚠️ session close timed out — continuing')
}
