import { getApiDeps } from '@/api/deps';
import { postStubAuthorize } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };
// Answers 404 unless PAYMENTS_MODE=stub (which env validation forbids in production).
export const POST = handle(async (req: Request, ctx: Ctx) =>
  postStubAuthorize(getApiDeps(), req, (await ctx.params).id),
);
