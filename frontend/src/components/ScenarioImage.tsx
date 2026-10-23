'use client'

import { useState } from 'react'
import type { ScenarioStyle } from '@/lib/scenarios'

/**
 * ScenarioImage — a 16:9 cinematic slot for a hands-free scenario. Renders the
 * AI-generated image at `src` once the founder drops it into /public; until the
 * file exists (or if it 404s), it shows a styled placeholder evoking the scene
 * so the gallery reads visually right away.
 */
export default function ScenarioImage({
  src,
  alt,
  scene,
  style,
  priority = false,
}: {
  src: string
  alt: string
  scene: string
  style: ScenarioStyle
  priority?: boolean
}) {
  const [failed, setFailed] = useState(false)

  return (
    <div className="relative w-full aspect-video overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)]">
      {/* Placeholder (cinematic gradient + voice motif) — always behind */}
      <div
        aria-hidden={!failed}
        className="absolute inset-0 flex flex-col items-center justify-center text-center px-6"
        style={{
          background:
            style === 'cabin'
              ? 'radial-gradient(120% 80% at 50% 110%, color-mix(in oklab, var(--accent) 28%, transparent) 0%, transparent 55%), linear-gradient(180deg, #0b0b0f 0%, #141019 100%)'
              : 'radial-gradient(90% 70% at 70% 20%, color-mix(in oklab, var(--accent) 20%, transparent) 0%, transparent 55%), linear-gradient(180deg, #0c0d12 0%, #111018 100%)',
        }}
      >
        {/* Voice orb motif */}
        <span className="relative flex items-center justify-center">
          <span className="absolute w-16 h-16 rounded-full bg-[var(--accent)]/15 animate-ping" style={{ animationDuration: '2.4s' }} />
          <span className="w-10 h-10 rounded-full bg-[var(--accent)]/70 shadow-[0_0_40px_var(--accent)]" />
        </span>
        <p className="mt-5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
          {style === 'cabin' ? 'Cabin POV · cinematic render' : 'Scene · cinematic render'}
        </p>
        <p className="mt-1.5 max-w-[42ch] text-[12.5px] text-[var(--text-secondary)] leading-relaxed">{scene}</p>
      </div>

      {/* Real image on top — hidden until loaded; onError reveals placeholder */}
      {!failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          onError={() => setFailed(true)}
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
    </div>
  )
}
