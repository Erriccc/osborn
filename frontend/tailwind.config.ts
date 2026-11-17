import type { Config } from 'tailwindcss'
import plugin from 'tailwindcss/plugin'
import defaultColors from 'tailwindcss/colors'

// Light / dark theme (see src/lib/theme.ts). The chat is written with Tailwind's
// gray scales and colour shades tuned for a dark page. Rather than edit those
// classes, every shade is a CSS variable: in dark it holds Tailwind's own value
// (so dark renders exactly as before), and under [data-theme="light"] it holds
// a light-theme counterpart. Text, surfaces and borders get separate ramps,
// because `text-gray-400` (secondary text) and `bg-gray-800` (a card) need
// different light values. Channels are "r g b" so `bg-gray-800/60` still works.

type Shade = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950'
const SHADES: Shade[] = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']
const GRAYS = ['gray', 'neutral', 'slate', 'zinc', 'stone'] as const
const CHROMA = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky',
  'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'] as const
type Role = 'bg' | 'tx' | 'bd'

// One warm light ramp per role, shared by every gray scale (the light theme is
// one palette, matching --background / --surface in globals.css).
// null = keep the scale's own Tailwind value (dark text on amber chips etc.).
const LIGHT_GRAY: Record<Role, Record<Shade, string | null>> = {
  // Surfaces: the dark ramp mirrored — 950 page, 900 panel, 800 card/input, 700 hover.
  bg: { 50: '#1c1a16', 100: '#2b2822', 200: '#3a362f', 300: '#57524a', 400: '#8a857a', 500: '#a8a296',
    600: '#cfc9bd', 700: '#e2ded5', 800: '#ece9e2', 900: '#f4f2ed', 950: '#faf9f6' },
  // Text: 50–300 primary ink, 400 secondary, 500 muted (AA on every surface above), 600+ disabled.
  tx: { 50: '#1c1a16', 100: '#1f1d19', 200: '#26231e', 300: '#37332c', 400: '#57524a', 500: '#6b665c',
    600: '#857f74', 700: '#a29c90', 800: null, 900: null, 950: null },
  // Borders: 700 is the standard border, 800 the subtle one.
  bd: { 50: '#1c1a16', 100: '#3a362f', 200: '#57524a', 300: '#8a857a', 400: '#a8a296', 500: '#bdb7ab',
    600: '#cfc9bd', 700: '#d8d2c6', 800: '#e6e1d8', 900: '#eeebe4', 950: '#f4f2ed' },
}
// Colour shades: light tints for dark-tint surfaces, deeper shades for text.
const LIGHT_CHROMA: Record<'bg' | 'tx', Partial<Record<Shade, Shade>>> = {
  bg: { 800: '200', 900: '100', 950: '50' },
  tx: { 50: '950', 100: '900', 200: '800', 300: '800', 400: '700', 500: '700', 600: '700' },
}

const palette = defaultColors as unknown as Record<string, Record<Shade, string>>
const rgb = (hex: string) => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(' ')
}
const v = (name: string) => `rgb(var(${name}) / <alpha-value>)`
const varName = (scale: string, role: Role, s: Shade) => `--th-${scale}-${role}-${s}`

const dark: Record<string, string> = {}
const light: Record<string, string> = {}
const roleColors: Record<Role, Record<string, Record<string, string>>> = { bg: {}, tx: {}, bd: {} }

for (const scale of GRAYS) {
  for (const role of ['bg', 'tx', 'bd'] as Role[]) {
    roleColors[role][scale] = {}
    for (const s of SHADES) {
      const name = varName(scale, role, s)
      dark[name] = rgb(palette[scale][s])
      light[name] = rgb(LIGHT_GRAY[role][s] ?? palette[scale][s])
      roleColors[role][scale][s] = v(name)
    }
  }
}
for (const c of CHROMA) {
  for (const role of ['bg', 'tx'] as const) {
    const map = LIGHT_CHROMA[role]
    const out: Record<string, string> = { ...palette[c] }
    for (const s of Object.keys(map) as Shade[]) {
      const name = varName(c, role, s)
      dark[name] = rgb(palette[c][s])
      light[name] = rgb(palette[c][map[s]!])
      out[s] = v(name)
    }
    roleColors[role][c] = out
    if (role === 'bg') roleColors.bd[c] = out
  }
}
// Primary ink for text that used to be text-white on a gray surface.
dark['--th-ink'] = '255 255 255'
light['--th-ink'] = rgb(LIGHT_GRAY.tx[50]!)
// Preflight's colour for a bare `border` (Tailwind's gray-200).
dark['--th-border-default'] = rgb(palette.gray['200'])
light['--th-border-default'] = rgb(LIGHT_GRAY.bd['700']!)

// The design tokens in globals.css as named colours, so an opacity modifier
// works (`bg-surface-2/40`): `bg-[var(--surface-2)]/40` compiles to invalid
// CSS, because the token is a hex value.
const TOKENS = ['background', 'foreground', 'surface', 'surface-raised', 'surface-2', 'border', 'border-subtle',
  'accent', 'accent-dim', 'text-primary', 'text-secondary', 'text-muted',
  'voice-idle', 'voice-listening', 'voice-thinking', 'voice-speaking', 'voice-error']
const tokenColors = Object.fromEntries(TOKENS.map(t =>
  [t, `color-mix(in srgb, var(--${t}) calc(<alpha-value> * 100%), transparent)`]))

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: { ...roleColors.bg, ...tokenColors, ink: v('--th-ink') },
      textColor: { ...roleColors.tx },
      placeholderColor: { ...roleColors.tx },
      borderColor: { ...roleColors.bd, DEFAULT: 'rgb(var(--th-border-default))' },
      divideColor: { ...roleColors.bd, DEFAULT: 'rgb(var(--th-border-default))' },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      // Dark is the default and also re-applies inside any [data-theme="dark"]
      // island (the live browser feed), so a dark island stays dark in light mode.
      addBase({
        ':root, [data-theme="dark"]': dark,
        '[data-theme="light"]': light,
      })
    }),
  ],
}
export default config
