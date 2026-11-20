import { renameSync, writeFileSync } from 'fs'

// One profile save at a time: a call made while a save runs waits for it, then
// runs one more (later calls in the meantime share that one). Once `stopped()`
// is true (shutdown has taken over) the interval tick no longer starts a save.
export function serialSaver(save: () => Promise<void>, stopped: () => boolean = () => false) {
  let running: Promise<void> | null = null
  let queued: Promise<void> | null = null
  const run = (): Promise<void> => {
    running = save().catch(() => {}).finally(() => { running = null })
    return running
  }
  const now = (): Promise<void> => {
    if (!running) return run()
    if (!queued) queued = running.then(() => { queued = null; return run() })
    return queued
  }
  return { now, tick: () => { if (!stopped()) void now() } }
}

// Write whole or not at all: a crash mid-write leaves the old file, never a torn one.
export function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}
