import { getApiDeps } from '@/api/deps';
import { postStartOffering } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };
export const POST = handle(async (req: Request, ctx: Ctx) =>
  postStartOffering(getApiDeps(), req, (await ctx.params).id),
);
