/**
 * osborn dev-router — fleet-level wildcard subdomain router
 *
 * Runs as a small Fly app at osborn-dev-router.fly.dev.
 * DNS: *.dev.voice-native.com CNAME osborn-dev-router.fly.dev
 * Cert: fly certs add "*.dev.voice-native.com" (run once on this app)
 *
 * Flow:
 *   Browser → 3000-osborn-abc.dev.voice-native.com
 *   → This router receives the request (wildcard cert terminates TLS)
 *   → Parses HOST: label "3000-osborn-abc" → port=3000, appName="osborn-abc"
 *   → Responds: fly-replay: app=osborn-abc;state=port:3000
 *   → Fly replays the original request to osborn-abc.fly.dev (port 443 / the agent)
 *   → Agent receives request; reads Host header or fly-replay-src to extract port
 *   → Agent proxies to localhost:3000 at root (no path prefix, WebSocket-clean)
 */

import { createServer } from 'node:http'

const DEV_DOMAIN = process.env.DEV_DOMAIN || 'dev.voice-native.com'
const PORT = parseInt(process.env.PORT || '8080', 10)

function parseLabel(host) {
  // host may include :port suffix — strip it
  const hostname = host.split(':')[0].toLowerCase()
  const suffix = '.' + DEV_DOMAIN
  if (!hostname.endsWith(suffix)) return null
  const label = hostname.slice(0, -suffix.length) // e.g. "3000-osborn-abc"
  const dashIdx = label.indexOf('-')
  if (dashIdx <= 0) return null
  const portNum = parseInt(label.slice(0, dashIdx), 10)
  const appName = label.slice(dashIdx + 1)   // e.g. "osborn-abc"
  if (isNaN(portNum) || portNum < 1 || portNum > 65535 || !appName) return null
  return { port: portNum, appName }
}

const server = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  const host = req.headers.host || ''
  const parsed = parseLabel(host)

  if (!parsed) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end(`Expected HOST: PORT-APPNAME.${DEV_DOMAIN}`)
    return
  }

  const { port, appName } = parsed

  // fly-replay tells Fly to replay the original request to the target app.
  // state=port:PORT is passed through as fly-replay-src on the replayed request
  // so the agent can read it even if Fly rewrites the Host header.
  res.writeHead(307, {
    'fly-replay': `app=${appName};state=port:${port}`,
    'content-type': 'text/plain',
  })
  res.end(`Routing to ${appName} port ${port}`)
})

server.listen(PORT, () => {
  console.log(`[dev-router] Listening on :${PORT}  domain: ${DEV_DOMAIN}`)
})
