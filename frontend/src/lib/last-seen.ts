// Structural type so both the SSR client and the service-role client fit.
interface InstancesClient {
  from(table: 'instances'): {
    update(values: { last_seen: string }): {
      eq(column: 'user_id', value: string): PromiseLike<{ error: { message: string } | null }>
    }
  }
}

/** Record activity on the user's machine (the admin "Last active" reads instances.last_seen). Never awaited: a failed write must not slow or fail the request. */
export function touchLastSeen(client: InstancesClient, userId: string): void {
  client.from('instances').update({ last_seen: new Date().toISOString() }).eq('user_id', userId).then(({ error }) => { if (error) console.warn(`[last-seen] write failed for ${userId}: ${error.message}`) }, () => {})
}
