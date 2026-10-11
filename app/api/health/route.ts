import { pingDb } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = await pingDb();
  return Response.json({ ok: true, db });
}
