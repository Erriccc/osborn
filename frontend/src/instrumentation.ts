export async function register() {
  // Log immediately so we know register() was called — before any async work
  console.log('[instrumentation] register() called, NEXT_RUNTIME =', process.env.NEXT_RUNTIME)

  // Only run on the Node.js server runtime, not in the edge runtime or client
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[instrumentation] server started — triggering image build check')
    try {
      const { checkImageBuild } = await import('./lib/image-build-check')
      const run = () =>
        checkImageBuild().catch((err) => {
          console.error('[instrumentation] image build check failed:', err?.message ?? err)
        })
      // Fire-and-forget at startup — do not await
      run()
      // ALSO re-check periodically: startup-only meant a publish AFTER the
      // last Railway deploy never got its image built (npm 0.9.77 published,
      // registry stuck at 0.9.76, frontend "update" had nothing to update
      // to — 2026-07-28). The check is cheap when the tag already exists
      // (one registry HTTP call), so a 15-min cadence closes the gap without
      // needing a Railway redeploy after every npm publish.
      setInterval(run, 15 * 60 * 1000)
    } catch (err: unknown) {
      console.error('[instrumentation] failed to import image-build-check:', err)
    }
  }
}
