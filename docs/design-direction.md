# Osborn Design Direction — "Warm Oracle" (est. 2026-08-01)

The product identity: **a voice with a presence, not a chat app with a mic.**
References the user named: Claude's app, example.com, voice-mode primitives
(ChatGPT AVM / Gemini Live / Perplexity voice). Full research in session
c8dc09f2 (two subagent reports: Claude UI anatomy + example.com tokens/icons/type).

## Foundations (SHIPPED, commit fcd68f2 + bda87c3)
- **Type**: Fraunces (display serif — greetings, wordmark, voice-state labels,
  assistant identity) · Instrument Sans (UI body) · JetBrains Mono (machine
  truth: times, tokens, counts). Wired via next/font in `layout.tsx`;
  `--font-display` + `.font-display` in globals.
- **Voice-state grammar** (globals.css tokens + keyframes): idle `#4a4740`
  breathe · listening amber `#d4a853` pulse · thinking violet `#9b8ec4`
  shimmer · speaking sage `#6faf8f` ripple · error terracotta `#c4756b`.
  The ORB (StatusIndicator in VoiceRoom.tsx) renders these — state reads from
  color+motion, never labels alone.
- **Icons**: `@phosphor-icons/react`, weight="duotone", accent-tinted. NO
  emoji glyphs in product chrome (agent cards done; sweep the rest).
- **Palette**: keep the existing warm near-black (`#0c0b09`) + amber
  (`#d4a853`) tokens — already on-direction. One accent, used sparingly.
  Light theme: warm paper (`#faf9f6`) + deeper amber (`#8a6210`); System /
  Light / Dark in Settings → Preferences (`frontend/src/lib/theme.ts`).
- **Machine presence**: the UI always says WHERE the machine runs
  ("Cloud · Chicago" badge, 📍 in machine card — /health `region`, 0.9.100).

## Principles (apply to every future UI change)
1. Voice state is the hero; chrome recedes during conversation.
2. Serif = the voice speaking; sans = the interface; mono = the machine.
3. Dashboard is a launcher (greeting → talk → recent context), not an admin panel.
4. Mobile-first, verified: the review loop and required widths are in
   CLAUDE.md "UI changes (required)"; a layout change is also captured at iPad
   (768×1024) and iPad landscape (1024×768).
5. Motion is state, not decoration: staggered reveals on lists, breathing on
   idle, shimmer on thinking. One well-orchestrated moment beats many
   micro-effects.

## Productivity references per surface

Each UI change names its model from this table and is scored 1–10 for
familiarity against it (method: issue #105; 10 = as instantly understood as
the avatar top-right).

| Surface | Model | Pattern to borrow |
|---|---|---|
| Agent work in chat | Cursor / Claude Code agent panel, GitHub Copilot chat | One collapsible row per step ("Edited 3 files ▸"); detail on tap |
| Messages | ChatGPT / Claude iOS | Assistant full width; the user's turns as right-aligned bubbles |
| Activity log / Running | Linear activity, Vercel deploy log | Plain-language timeline in a sheet; raw logs behind "View logs" |
| Approvals | GitHub review states, Cursor auto-run | One mode chip; risky modes coloured and confirmed once |
| Rooms / sessions | Slack switcher, Linear Cmd+K, Claude sidebar | Search first, unread dots, newest first |
| Saved files | Notion links, Slack file messages | One compact row per file; preview sheet with share/download |
| Call controls | Slack huddles, Zoom, Gemini Live | Docked at the bottom, in thumb reach; mute, end, live timer |
| Meetings | Granola, Otter | Notes as it goes; afterwards summary, actions, transcript |
| Dashboard | Things 3 Today, Linear My Issues | One "today": running, finished, needs you; no repeated cards |
| Machine / RAM / Code | Railway, Render metrics | Off the main surface; a status dot opening a metrics sheet |
| Store | Raycast Store, VS Code Extensions | Installed / Browse, update badges, permissions before install |
| Theme | Linear, Notion, Things 3 | Follow the system; System / Light / Dark in Preferences |

## Header/tray management (2026-08-01, from live mobile QA)

**The rule: nothing disappears — it collapses.** Every control has a priority
tier; viewport width decides its HOME, never its existence:

| Tier | Controls | iPhone (390) | iPad/desktop |
|---|---|---|---|
| 1 · State | voice orb + label, clock | header, always | header |
| 2 · Critical action | **Disconnect** (stops billing) | header, `shrink-0` — never loses the width fight | header |
| 3 · Frequent | Agents, Skills, mobile menu | header (icon+badge) | header (icon+label) |
| 4 · Occasional | auto-approve, mute, meeting, files, copy | **collapse into mobile menu** (with state badges, e.g. ON/OFF) | header |
| 5 · Identity | settings + profile | ONE control: avatar opens settings sheet | same |

Grounding (research): iOS HIG 44pt touch targets + ≤5 top-level actions;
progressive disclosure ("priority+overflow" nav pattern — visible = state +
primary, everything else one tap away in a single overflow, never two
overflows); Claude iOS 2026 bottom-tab experiment (≤4 destinations, thumb
reach); destructive/identity actions never one accidental tap (avatar no
longer signs out directly).

Popover rule: on <sm, panels anchor to the VIEWPORT (inset-x-3 below header),
never to their trigger button — button-anchored panels jut off-screen when the
trigger sits mid-header.

Next step on this path (backlog): replace the mobile menu with a bottom tab
bar (Talk / Sessions / Files / Menu) once activity data says which four earn
the slots.

## Backlog (in rough order)
- Chat: dock the orb larger in an empty-conversation hero ("the presence"),
  serif greeting in empty state; edge-glow while background research runs.
- Replace remaining emoji chrome (skills chips, project 🗂️, session gate 🗂)
  with Phosphor duotone.
- Session cards: first-line serif preview + hover elevation.
- Bottom tab bar experiment (Chats / Sessions / Files / Settings) on mobile.
- Barge-in affordance: orb visibly yields on interrupt.
- Use real user activity data (Supabase sessions) to prioritize surfaces.
- Machine-local time alongside user clock (machines run UTC; show both when
  they differ).
