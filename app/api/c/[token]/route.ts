import { getApiDeps } from '@/api/deps';
import { getOffer } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ token: string }> };
// GET never consumes the token.
export const GET = handle(async (req: Request, ctx: Ctx) =>
  getOffer(getApiDeps(), req, (await ctx.params).token),
);
