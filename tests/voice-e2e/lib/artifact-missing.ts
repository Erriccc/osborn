// Why GET /artifact has no frame for a task, as a structured 404 body.
export interface ArtifactMissing { error: string; code: 'task_unknown' | 'no_frame_captured' | 'frame_file_missing' }

export function artifactMissing(n: number, run: string | null, task: { artifact?: string | null } | undefined): ArtifactMissing {
  const where = run ? ` in run ${run}` : ''
  if (!task) return { code: 'task_unknown', error: `no task ${n}${where} — GET /tasks or GET /runs lists them` }
  if (!task.artifact) return { code: 'no_frame_captured', error: `task ${n}${where} produced no frame: page.screenshot failed and no live stream frame was available` }
  return { code: 'frame_file_missing', error: `task ${n}${where}'s frame file is gone from disk (pruned or removed)` }
}
