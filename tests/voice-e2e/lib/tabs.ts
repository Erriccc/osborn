import type { BrowserContext, Page } from '@playwright/test'
import { installReactiveMic } from './reactive-mic'
import { installActionVisualizer } from './action-visualizer'

/**
 * Multi-tab helpers — open, list, and switch between tabs during a run.
 * New tabs get the reactive-mic patch + action visualizer so any of them can
 * hold a voice session and show click effects. `bringToFront()` is what makes
 * the switched-to tab the one the screencast (live stream) shows.
 */

export async function openTab(context: BrowserContext, url?: string): Promise<Page> {
  const page = await context.newPage()
  await installReactiveMic(page)
  await installActionVisualizer(page)
  if (url) await page.goto(url, { timeout: 45_000 })
  await page.bringToFront()
  return page
}

export function listTabs(context: BrowserContext): { index: number; url: string; title: Promise<string> }[] {
  return context.pages().map((p, index) => ({ index, url: p.url(), title: p.title().catch(() => '') }))
}

/** Switch focus (and the live-stream view) to a tab by index or predicate. */
export async function switchTab(
  context: BrowserContext,
  which: number | ((p: Page) => boolean),
): Promise<Page> {
  const pages = context.pages()
  const page = typeof which === 'number' ? pages[which] : pages.find(which)
  if (!page) throw new Error(`no tab matched ${String(which)}`)
  await page.bringToFront()
  return page
}

/** Close a tab by index; returns the nearest remaining tab as the new active. */
export async function closeTab(context: BrowserContext, which: number): Promise<Page> {
  const pages = context.pages()
  const page = pages[which]
  if (!page) throw new Error(`no tab at index ${which}`)
  if (pages.length === 1) throw new Error('refusing to close the last tab — use /end to shut the engine down')
  await page.close({ runBeforeUnload: false }).catch(() => {})
  const remaining = context.pages()
  const next = remaining[Math.min(which, remaining.length - 1)]
  await next.bringToFront()
  return next
}
