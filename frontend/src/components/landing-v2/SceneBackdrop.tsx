'use client'

import { useState } from 'react'

/**
 * SceneBackdrop — a FULL-BLEED cinematic image that fills its (relative) parent.
 * The feel-first sibling of <ScenarioImage> (which renders a rounded 16:9 card):
 * this one bleeds edge-to-edge behind the hero and the scenario bands.
 *
 * It renders the committed AI-generated render at `src`; if that file is missing
 * or 404s, it falls back to a cinematic gradient so the section still reads as a
 * moody cabin/scene rather than a broken box. No scrim here — the caller layers
 * its own gradient over the top so copy/orb stay legible.
 *
 * Client component only because it needs onError to swap in the fallback.
 */
export default function SceneBackdrop({
  src,
  alt,
  style = 'cabin',
  priority = false,
  objectPosition = 'center',
  className = '',
}: {
  src: string
  alt: string
  style?: 'cabin' | 'scene'
  priority?: boolean
  objectPosition?: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)

  return (
    <div className={`absolute inset-0 overflow-hidden ${className}`}>
      {/* Cinematic gradient fallback — always behind, shown if the render is absent */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            style === 'cabin'
              ? 'radial-gradient(120% 85% at 50% 115%, color-mix(in oklab, var(--accent) 26%, transparent) 0%, transparent 58%), linear-gradient(180deg, #0c0b09 0%, #16120b 100%)'
              : 'radial-gradient(90% 75% at 68% 18%, color-mix(in oklab, var(--accent) 18%, transparent) 0%, transparent 56%), linear-gradient(180deg, #0c0b09 0%, #131109 100%)',
        }}
      />
      {!failed && (
        // Plain <img> (not next/image) to match the project's ScenarioImage
        // pattern and keep graceful onError fallback for not-yet-generated renders.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ objectPosition }}
        />
      )}
    </div>
  )
}
