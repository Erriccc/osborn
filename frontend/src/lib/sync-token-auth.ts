// Machine-to-frontend auth: the agent posts with `Authorization: Bearer <sync token>`,
// and the token names one instances row, so one account. Shared by every route the
// agent calls with its sync token (/api/phone/code, /api/follow-through).

/** The bearer token of a request, or '' when there is none. */
export function bearerToken(request: Request): string {
  return (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
}

/** The user whose machine holds `token`, or null unless exactly one instances row has it. */
export async function syncTokenUserId(admin: any, token: string): Promise<string | null> {
  const { data: rows } = await admin.from('instances').select('user_id').eq('sync_token', token).limit(2)
  return rows?.length === 1 && typeof rows[0]?.user_id === 'string' ? rows[0].user_id : null
}
