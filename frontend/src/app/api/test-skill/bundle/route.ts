// Legacy alias — see ../../browser-screen-recorder/bundle/route.ts. Installed
// clients curl this without -L, so we re-export the new handler rather than
// redirecting. New installs use /api/browser-screen-recorder/bundle.
export { dynamic, GET } from '../../browser-screen-recorder/bundle/route'
