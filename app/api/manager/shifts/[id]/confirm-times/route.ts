import { getApiDeps } from '@/api/deps';
import { postConfirmTimes } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };
export const POST = handle(async (req: Request, ctx: Ctx) =>
  postConfirmTimes(getApiDeps(), req, (await ctx.params).id),
);
