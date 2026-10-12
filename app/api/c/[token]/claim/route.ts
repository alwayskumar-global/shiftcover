import { getApiDeps } from '@/api/deps';
import { postClaim } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ token: string }> };
export const POST = handle(async (req: Request, ctx: Ctx) =>
  postClaim(getApiDeps(), req, (await ctx.params).token),
);
