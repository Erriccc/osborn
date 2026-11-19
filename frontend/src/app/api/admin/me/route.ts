import { NextResponse } from 'next/server'
import { requireAdmin, AdminAuthError } from '@/lib/admin'

/**
 * GET /api/admin/me — whether the signed-in user is an admin, as `{ admin }`
 * with a 200 either way, so the client probe (lib/use-is-admin) does not log a
 * 403 on every page for everyone else. It only answers the question; the
 * /api/admin/* data routes stay the enforcement point (lib/admin.ts).
 */
export async function GET() {
  try {
    await requireAdmin()
    return NextResponse.json({ admin: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ admin: false }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json({ error: 'Could not check admin access' }, { status: 500 })
  }
}
