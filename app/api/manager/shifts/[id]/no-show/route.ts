import { getApiDeps } from '@/api/deps';
import { postNoShow } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };
export const POST = handle(async (req: Request, ctx: Ctx) =>
  postNoShow(getApiDeps(), req, (await ctx.params).id),
);
