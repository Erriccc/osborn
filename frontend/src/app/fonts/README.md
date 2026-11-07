# Self-hosted fonts

These files are loaded by `src/app/layout.tsx` via `next/font/local`, so
`next build` never fetches fonts.googleapis.com. That fetch broke Railway build
ba912883: `next/font/google` failed in loader.js with "Cannot read properties of
null (reading '1')" after Google returned an unexpected font URL.

They match what `next/font/google` used to request: the `latin` subset,
`display: swap`. Google serves these families as variable fonts, so each
family/style is one woff2 that covers the weight range.

| File | Family | Style | Weights used | CSS variable |
|---|---|---|---|---|
| `Fraunces-latin-wght.woff2` | Fraunces | normal | 400-700 | `--font-display-loaded` |
| `Fraunces-Italic-latin-wght.woff2` | Fraunces | italic | 400-700 | `--font-display-loaded` |
| `InstrumentSans-latin-wght.woff2` | Instrument Sans | normal | 400-700 | `--font-sans-loaded` |
| `JetBrainsMono-latin-wght.woff2` | JetBrains Mono | normal | 400-500 | `--font-mono-loaded` |

Source: the Google Fonts CSS2 API (fonts.gstatic.com: fraunces v38,
instrumentsans v4, jetbrainsmono v24), downloaded 2026-11-07 with a desktop
Chrome User-Agent so the API returns woff2.

## License

All three families are licensed under the SIL Open Font License 1.1 (OFL).
`license: "OFL"` was checked in each family's METADATA.pb in google/fonts.
The full license text and copyright notices are in `OFL.txt` next to this file.

- Fraunces: Copyright 2018 The Fraunces Project Authors (https://github.com/undercasetype/Fraunces)
- Instrument Sans: Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans)
- JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

To update a font, download the new latin woff2 from the CSS2 API and replace
the file. Keep the file names, or update `layout.tsx` to match.
