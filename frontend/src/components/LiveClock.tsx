'use client'

import { useEffect, useState } from 'react'

/**
 * LiveClock — always-visible ticking date/time/timezone so every screenshot
 * carries a timestamp. Mounted in the chat header (VoiceRoom) and the
 * dashboard header. Seconds tick + pulse dot keep the UI feeling alive.
 *
 * `showDate` adds the short date (dashboard uses it; chat stays compact).
 */
export default function LiveClock({ showDate = false }: { showDate?: boolean }) {
  // null until mounted — avoids SSR/client hydration mismatch on time text.
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  if (!now) return null

  const hh = String(now.getHours() % 12 || 12).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const ampm = now.getHours() >= 12 ? 'PM' : 'AM'
  // Short timezone name (e.g. CDT, PST) from the runtime locale.
  const tz = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName')?.value || ''
  const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-800/40 border border-gray-700/30 select-none shrink-0"
      title={now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-40" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-400/80" />
      </span>
      {/* Responsive: narrow screens keep "6:17 PM"; date/seconds/tz appear ≥sm
          (they were overflowing the 390px header and hiding the whole clock) */}
      {showDate && <span className="hidden sm:inline text-[10px] font-medium text-gray-400">{date}</span>}
      <span className="font-mono text-[11px] tabular-nums text-gray-300 tracking-tight">
        {hh}:{mm}<span className="hidden sm:inline text-gray-500">:{ss}</span>
      </span>
      <span className="text-[9px] font-medium text-gray-500">{ampm}</span>
      {tz && <span className="hidden sm:inline text-[9px] font-medium text-gray-600">{tz}</span>}
    </div>
  )
}
