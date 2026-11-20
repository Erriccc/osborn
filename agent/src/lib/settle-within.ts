/** Resolve with the promise's outcome, or `false` once `ms` pass. Never rejects, never leaves a timer running. */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms) })
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
