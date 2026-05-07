export async function register() {
  // Log immediately so we know register() was called — before any async work
  console.log('[instrumentation] register() called, NEXT_RUNTIME =', process.env.NEXT_RUNTIME)

  // Only run on the Node.js server runtime, not in the edge runtime or client
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[instrumentation] server started — triggering image build check')
    try {
      const { checkImageBuild } = await import('./lib/image-build-check')
      // Fire-and-forget — do not await
      checkImageBuild().catch((err) => {
        console.error('[instrumentation] image build check failed:', err?.message ?? err)
      })
    } catch (err: unknown) {
      console.error('[instrumentation] failed to import image-build-check:', err)
    }
  }
}
