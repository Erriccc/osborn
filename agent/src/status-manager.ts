/**
 * Status Manager - Handles background task status and conversational updates
 *
 * This module enables a Siri-like experience where:
 * 1. Background research/tasks run independently
 * 2. Status updates can be polled via a tool
 * 3. The voice LLM can naturally ask about progress
 * 4. Results are delivered conversationally
 */

export interface TaskStatus {
  id: string
  type: 'research' | 'execute' | 'search'
  query: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: string
  startedAt: number
  completedAt?: number
  progress?: number // 0-100
  progressUpdates: string[] // Interim updates during execution
  lastUpdate?: string // Most recent update for voice
}

export interface StatusUpdate {
  hasUpdates: boolean
  completedTasks: TaskStatus[]
  runningTasks: TaskStatus[]
  pendingTasks: TaskStatus[]
  summary: string
}

export class StatusManager {
  private tasks: Map<string, TaskStatus> = new Map()
  private lastCheckTime: number = Date.now()
  private conversationContext: string[] = []

  /**
   * Start tracking a new task (generates new ID)
   */
  startTask(type: TaskStatus['type'], query: string): string {
    const id = `task-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    return this.registerTask(id, type, query)
  }

  /**
   * Register a task with a specific ID (used when brain already created the task)
   */
  registerTask(id: string, type: TaskStatus['type'], query: string): string {
    // Skip if task already exists
    if (this.tasks.has(id)) {
      console.log(`📋 [Status] Task already registered: ${id}`)
      return id
    }

    this.tasks.set(id, {
      id,
      type,
      query,
      status: 'pending',
      startedAt: Date.now(),
      progressUpdates: [],
    })

    console.log(`📋 [Status] Task registered: ${id} - ${query.substring(0, 50)}...`)
    return id
  }

  /**
   * Mark a task as running
   */
  markRunning(id: string, progress?: number) {
    const task = this.tasks.get(id)
    if (task) {
      task.status = 'running'
      if (progress !== undefined) task.progress = progress
    }
  }

  /**
   * Add a progress update to a running task (for interim voice updates)
   */
  addProgressUpdate(id: string, update: string) {
    const task = this.tasks.get(id)
    if (task) {
      task.progressUpdates.push(update)
      task.lastUpdate = update
      console.log(`📊 [Status] Progress update for ${id.substring(0, 12)}: ${update.substring(0, 60)}...`)
    }
  }

  /**
   * Get the latest unspoken progress update for any running task
   * Returns null if no new updates available
   */
  getLatestProgressUpdate(): { taskId: string; update: string } | null {
    const runningTasks = Array.from(this.tasks.values()).filter(t => t.status === 'running')

    for (const task of runningTasks) {
      if (task.lastUpdate) {
        const update = task.lastUpdate
        task.lastUpdate = undefined // Mark as consumed
        return { taskId: task.id, update }
      }
    }
    return null
  }

  /**
   * Check if there are new progress updates available
   */
  hasProgressUpdates(): boolean {
    return Array.from(this.tasks.values()).some(t => t.status === 'running' && t.lastUpdate)
  }

  /**
   * Complete a task with result
   */
  completeTask(id: string, result: string, success: boolean = true) {
    const task = this.tasks.get(id)
    if (task) {
      task.status = success ? 'completed' : 'failed'
      task.result = result
      task.completedAt = Date.now()
      console.log(`✅ [Status] Task ${success ? 'completed' : 'failed'}: ${id}`)
    }
  }

  /**
   * Add context from conversation
   */
  addContext(context: string) {
    this.conversationContext.push(context)
    if (this.conversationContext.length > 10) {
      this.conversationContext.shift()
    }
  }

  /**
   * Get status update - called by the check_status tool
   */
  getStatusUpdate(): StatusUpdate {
    const now = Date.now()
    const timeSinceLastCheck = now - this.lastCheckTime
    this.lastCheckTime = now

    const allTasks = Array.from(this.tasks.values())
    const completedTasks = allTasks.filter(t =>
      t.status === 'completed' && t.completedAt && t.completedAt > now - 60000 // Last minute
    )
    const runningTasks = allTasks.filter(t => t.status === 'running')
    const pendingTasks = allTasks.filter(t => t.status === 'pending')

    // Generate natural summary
    let summary = ''

    if (completedTasks.length > 0) {
      const results = completedTasks.map(t => {
        const shortResult = t.result?.substring(0, 200) || 'No result'
        return `${t.query}: ${shortResult}`
      }).join('\n')
      summary = `I found some results:\n${results}`
    } else if (runningTasks.length > 0) {
      const tasks = runningTasks.map(t => t.query).join(', ')
      const elapsed = Math.round((now - runningTasks[0].startedAt) / 1000)
      summary = `Still working on: ${tasks} (${elapsed}s elapsed)`
    } else if (pendingTasks.length > 0) {
      summary = `${pendingTasks.length} tasks queued, starting soon...`
    } else {
      summary = "No active tasks. What would you like me to work on?"
    }

    return {
      hasUpdates: completedTasks.length > 0,
      completedTasks,
      runningTasks,
      pendingTasks,
      summary,
    }
  }

  /**
   * Check if there are completed tasks to report
   */
  hasCompletedTasks(): boolean {
    return Array.from(this.tasks.values()).some(t =>
      t.status === 'completed' &&
      t.completedAt &&
      t.completedAt > this.lastCheckTime
    )
  }

  /**
   * Get a brief status for voice announcement
   */
  getBriefStatus(): string {
    const running = Array.from(this.tasks.values()).filter(t => t.status === 'running')
    const completed = Array.from(this.tasks.values()).filter(t => t.status === 'completed')

    if (running.length > 0) {
      return `Working on ${running.length} task${running.length > 1 ? 's' : ''}...`
    }
    if (completed.length > 0) {
      return `I have ${completed.length} result${completed.length > 1 ? 's' : ''} ready.`
    }
    return "Ready for your next request."
  }

  /**
   * Clear completed tasks after they've been reported
   */
  clearReportedTasks() {
    const now = Date.now()
    for (const [id, task] of this.tasks.entries()) {
      // Remove tasks that completed more than 2 minutes ago
      if (task.status === 'completed' && task.completedAt && task.completedAt < now - 120000) {
        this.tasks.delete(id)
      }
    }
  }

  /**
   * Get context summary for the brain
   */
  getContextSummary(): string {
    return this.conversationContext.slice(-5).join(' | ')
  }
}

// Singleton instance
export const statusManager = new StatusManager()
