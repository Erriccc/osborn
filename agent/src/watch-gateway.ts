/**
 * watch-gateway.ts — Track 2 watch bridge (native watchOS app ↔ LiveKit room).
 *
 * watchOS has no WKWebView and LiveKit's Swift SDK will not target it
 * (client-sdk-swift #288), so the native watch app (frontend/native/watchos/)
 * speaks a tiny WebSocket protocol to THIS gateway running on the user's own
 * machine, which bridges into their LiveKit room via @livekit/rtc-node:
 *
 *   watch ──WS JSON (control)──► gateway ──RTC data channel──► room
 *   watch ──WS binary (Int16LE PCM 24kHz mono)──► gateway ──resample 48k──► published mic track
 *   watch ◄──WS binary (Int16LE PCM 24kHz mono)── gateway ◄──decode+resample── subscribed agent track
 *
 * Protocol (see also GatewayLink.swift — the two must stay in sync):
 *   C→S text  {"type":"hello","watchId":string}                  — first message; joins the ACTIVE room
 *              {"type":"answer","qid":string,"allow":boolean}    — question sheet response
 *              {"type":"ping"}
 *   C→S bin   raw Int16LE mono PCM frames @24kHz (no header)
 *   S→C text  {"type":"state","agent":"idle|listening|thinking|speaking","room":string}
 *              {"type":"question","qid":string,"text":string}
 *              {"type":"joined","room":string} / {"type":"error","message":string} / {"type":"pong"}
 *   S→C bin   raw Int16LE mono PCM frames @24kHz (announced by {"type":"audio","rate":24000})
 *
 * One watch connection = one rtc-node Room. The gateway is dormant unless
 * started (index.ts gates on WATCH_GATEWAY=1).
 */

import { WebSocketServer, WebSocket } from 'ws'
import {
  Room,
  RoomEvent,
  AudioSource,
  AudioResampler,
  AudioStream,
  AudioFrame,
  LocalAudioTrack,
  TrackKind,
  TrackSource,
  TrackPublishOptions,
  type RemoteAudioTrack,
  type TrackPublication,
  type RemoteParticipant,
  type LocalTrack,
} from '@livekit/rtc-node'

const WATCH_PCM_RATE = 24_000
const ROOM_RATE = 48_000

export interface WatchGatewayOptions {
  port: number
  livekitUrl: string
  /** Returns the room the user's session is currently joined to (null = none). */
  getActiveRoom: () => string | null
  /** Mints a LiveKit JWT for the given room (publish+subscribe+data). */
  mintToken: (room: string) => Promise<string>
}

interface WatchSession {
  ws: WebSocket
  room: Room
  /** Upstream: watch PCM 24k → 48k frames pushed into the published track. */
  upResampler: AudioResampler
  upSource: AudioSource
  upTrack: LocalAudioTrack
  /** Downstream reader loop for the agent's audio track (cancels on teardown). */
  downReader?: ReadableStreamDefaultReader<AudioFrame>
  downResampler: AudioResampler
  downStream?: AudioStream
}

function wsSendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

export function startWatchGateway(opts: WatchGatewayOptions): { wss: WebSocketServer; close: () => void } {
  const wss = new WebSocketServer({ port: opts.port })
  const sessions = new Set<WatchSession>()

  console.log(`⌚️ Watch gateway listening on :${opts.port} (bridging to ${opts.livekitUrl})`)

  wss.on('connection', (ws) => {
    let session: WatchSession | null = null
    let helloDone = false

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Raw Int16LE PCM @24kHz from the watch mic → resample → publish.
        if (!session) return
        const pcm = new Int16Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        )
        const frame = new AudioFrame(pcm, WATCH_PCM_RATE, 1, pcm.length)
        for (const out of session.upResampler.push(frame)) {
          void session.upSource.captureFrame(out).catch(() => {})
        }
        return
      }

      let msg: any
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg.type === 'ping') {
        wsSendJson(ws, { type: 'pong' })
        return
      }

      if (!helloDone) {
        if (msg.type !== 'hello') {
          wsSendJson(ws, { type: 'error', message: 'expected hello first' })
          return
        }
        helloDone = true
        void handleHello(ws, String(msg.watchId || 'watch'), sessions).then((s) => {
          session = s
        })
        return
      }

      // Answers from the watch question sheet ride the room data channel with
      // the same shape the web UI sends, so the agent needs no new handling.
      if (msg.type === 'answer' && session) {
        const payload = JSON.stringify({
          type: 'permission_response',
          response: msg.allow ? 'allow' : 'deny',
          source: 'watch',
          qid: msg.qid,
        })
        void session.room.localParticipant
          ?.publishData(new TextEncoder().encode(payload), { reliable: true })
          .catch(() => {})
      }
    })

    ws.on('close', () => void teardown(session))
    ws.on('error', () => void teardown(session))

    async function teardown(s: WatchSession | null): Promise<void> {
      if (!s) return
      session = null
      sessions.delete(s)
      s.downReader?.cancel().catch(() => {})
      try {
        await s.upTrack.close()
      } catch { /* already closed */ }
      s.upResampler.close()
      s.downResampler.close()
      try {
        await s.room.disconnect()
      } catch { /* already disconnected */ }
    }

    async function handleHello(
      ws: WebSocket,
      watchId: string,
      activeSessions: Set<WatchSession>,
    ): Promise<WatchSession | null> {
      const activeRoom = opts.getActiveRoom()
      if (!activeRoom) {
        wsSendJson(ws, { type: 'error', message: 'no active session room — connect from the dashboard first' })
        ws.close()
        return null
      }

      const room = new Room()
      const upSource = new AudioSource(ROOM_RATE, 1)
      const upTrack = LocalAudioTrack.createAudioTrack(`watch-${watchId}-mic`, upSource)
      const s: WatchSession = {
        ws,
        room,
        upSource,
        upTrack,
        upResampler: new AudioResampler(WATCH_PCM_RATE, ROOM_RATE, 1),
        downResampler: new AudioResampler(ROOM_RATE, WATCH_PCM_RATE, 1),
      }

      room
        .on(RoomEvent.DataReceived, (payload: Uint8Array) => {
          // Room data (agent state, permission_request, …) → watch as JSON text.
          try {
            const text = new TextDecoder().decode(payload)
            const parsed = JSON.parse(text)
            if (parsed?.type === 'permission_request') {
              // The watch shows a yes/no sheet for blocking questions.
              wsSendJson(ws, {
                type: 'question',
                qid: parsed.toolUseId ?? parsed.toolName ?? 'perm',
                text: parsed.description ?? `Use ${parsed.toolName}?`,
              })
            } else if (parsed?.type === 'agent_state' || parsed?.type === 'state') {
              wsSendJson(ws, { type: 'state', agent: parsed.state ?? parsed.agent ?? 'idle', room: activeRoom })
            }
          } catch { /* non-JSON or non-object data — ignore */ }
        })
        .on(RoomEvent.TrackSubscribed, (
          track: RemoteAudioTrack,
          publication: TrackPublication,
          participant: RemoteParticipant,
        ) => {
          if (track.kind !== TrackKind.KIND_AUDIO) return
          console.log(`⌚️ Watch gateway: subscribing agent audio (${publication.source}, ${participant.identity})`)
          // Decode agent audio at room rate, resample down to 24k, ship to watch.
          const stream = new AudioStream(track, ROOM_RATE, 1)
          s.downStream = stream
          const reader = stream.getReader()
          s.downReader = reader
          wsSendJson(ws, { type: 'audio', rate: WATCH_PCM_RATE })
          void (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                if (ws.readyState !== WebSocket.OPEN) break
                for (const out of s.downResampler.push(value)) {
                  if (ws.readyState !== WebSocket.OPEN) break
                  ws.send(Buffer.from(out.data.buffer))
                }
              }
            } catch { /* reader cancelled or stream ended */ }
          })()
        })
        .on(RoomEvent.Disconnected, () => {
          wsSendJson(ws, { type: 'error', message: 'room disconnected' })
          void teardown(s)
        })

      try {
        await room.connect(opts.livekitUrl, await opts.mintToken(activeRoom), {
          autoSubscribe: true,
          dynacast: false,
        })
        await room.localParticipant!.publishTrack(
          upTrack as LocalTrack,
          new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
        )
      } catch (e) {
        console.log('⌚️ Watch gateway: room connect failed:', e instanceof Error ? e.message : e)
        wsSendJson(ws, { type: 'error', message: 'room connect failed' })
        void teardown(s)
        return null
      }

      activeSessions.add(s)
      console.log(`⌚️ Watch gateway: watch ${watchId} joined room ${activeRoom}`)
      wsSendJson(ws, { type: 'joined', room: activeRoom })
      return s
    }
  })

  return {
    wss,
    close: () => {
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
  }
}
