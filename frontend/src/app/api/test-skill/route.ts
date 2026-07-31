// Legacy alias — the voice-e2e skill was renamed to browser-screen-recorder.
// Self-updating clients in the wild curl this endpoint WITHOUT -L, so a 3xx
// redirect would break them; instead we re-export the new handler so this URL
// keeps serving the (renamed) skill verbatim. New installs use
// /api/browser-screen-recorder.
export { GET } from '../browser-screen-recorder/route'
