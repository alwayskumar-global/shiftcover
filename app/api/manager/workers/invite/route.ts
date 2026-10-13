import { getApiDeps } from '@/api/deps';
import { postInviteWorker } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
export const POST = handle((req: Request) => postInviteWorker(getApiDeps(), req));
