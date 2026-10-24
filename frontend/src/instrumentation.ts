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
      // Same orchestrator pattern for the browser-screen-recorder engine:
      // skill version (from the served file) vs Fly registry tag; when stale,
      // materialize the harness bundle and fly-deploy the engine. No CI.
      const { checkHarnessDeploy } = await import('./lib/harness-deploy-check')
      const runHarness = () =>
        checkHarnessDeploy().catch((err) => {
          console.error('[instrumentation] harness deploy check failed:', err?.message ?? err)
        })
      runHarness()
      setInterval(runHarness, 15 * 60 * 1000)

      // Warm machine pool: pre-provision ~2 spare Fly machines at boot so a new
      // user's first session starts in seconds instead of a 1-2 min cold create.
      // Fire-and-forget — must NEVER block startup or the healthcheck. No-ops
      // unless FLY_API_TOKEN is set (isMachinesConfigured) and the service-role
      // Supabase key is present (getPoolClient).
      if (process.env.FLY_API_TOKEN) {
        import('./lib/machine-pool')
          .then(({ ensurePool }) =>
            ensurePool().catch((err) => {
              console.error('[instrumentation] machine pool ensure failed:', err?.message ?? err)
            }),
          )
          .catch((err) => {
            console.error('[instrumentation] machine-pool import failed:', err?.message ?? err)
          })
      }
    } catch (err: unknown) {
      console.error('[instrumentation] failed to import image-build-check:', err)
    }
  }
}
