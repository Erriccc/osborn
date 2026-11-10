'use client'

// ── Inline audio controls (Phase C) ───────────────────────────────────────
// The mic / speaker pickers + speaker test, as a plain inline block with no
// popover or overlay shell. Rendered BOTH inside the desktop AudioPopover and
// inline in the mobile menu sheet, so audio controls live where the user
// already is instead of behind a separate floating overlay.
//
// Device labels only populate once the user has allowed mic access; picks
// apply live to the session via LiveKit's room.switchActiveDevice.

import { useEffect, useState } from 'react'
import { useRoomContext } from '@livekit/components-react'

export function AudioControls({ compact = false }: { compact?: boolean }) {
  const room = useRoomContext()
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    let cancelled = false
    const enumerate = () => {
      navigator.mediaDevices?.enumerateDevices?.().then((ds) => {
        if (cancelled) return
        setMics(ds.filter((d) => d.kind === 'audioinput'))
        setSpeakers(ds.filter((d) => d.kind === 'audiooutput'))
      }).catch(() => { /* enumeration blocked */ })
    }
    enumerate()
    // Labels fill in after a permission grant / device change — re-read then.
    navigator.mediaDevices?.addEventListener?.('devicechange', enumerate)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', enumerate)
    }
  }, [])

  const pick = async (kind: 'audioinput' | 'audiooutput', id: string) => {
    try { await room?.switchActiveDevice(kind, id) } catch { /* device unavailable */ }
  }
  const testSpeaker = () => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.frequency.value = 440; gain.gain.value = 0.07
      osc.connect(gain); gain.connect(ctx.destination); osc.start()
      setTimeout(() => { try { osc.stop(); void ctx.close() } catch { /* already closed */ } }, 600)
    } catch { /* no AudioContext */ }
  }

  return (
    <div className={`flex flex-col ${compact ? 'gap-2.5' : 'gap-3'}`}>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">Microphone</span>
        <select defaultValue="" onChange={(e) => pick('audioinput', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-2 text-base sm:text-[13px] text-gray-200 outline-none focus:border-amber-500/50">
          <option value="">Default microphone</option>
          {mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">Speaker</span>
        <select defaultValue="" onChange={(e) => pick('audiooutput', e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-2 text-base sm:text-[13px] text-gray-200 outline-none focus:border-amber-500/50">
          <option value="">Default speaker</option>
          {speakers.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
        </select>
      </label>
      <button onClick={testSpeaker}
        className="self-start rounded-lg bg-gray-800 border border-gray-700 px-3 py-1.5 text-[12.5px] text-gray-200 hover:border-amber-500/40 transition-colors">
        Test speaker (plays a tone)
      </button>
      <p className="text-[11px] text-gray-500 leading-relaxed">Device names appear once you&rsquo;ve allowed mic access. Picks apply live to this session.</p>
    </div>
  )
}
