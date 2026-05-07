export async function register() {
  // Only run on the Node.js server runtime, not in the edge runtime or client
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { checkImageBuild } = await import('./lib/image-build-check')
    // Fire-and-forget — do not await
    checkImageBuild().catch((err) => {
      process.stderr.write(`[instrumentation] image build check failed: ${err?.message ?? err}\n`)
    })
  }
}
