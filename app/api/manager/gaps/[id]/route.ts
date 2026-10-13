import { getApiDeps } from '@/api/deps';
import { getGap } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };
export const GET = handle(async (req: Request, ctx: Ctx) =>
  getGap(getApiDeps(), req, (await ctx.params).id),
);
