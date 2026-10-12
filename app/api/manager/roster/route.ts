import { getApiDeps } from '@/api/deps';
import { getRoster } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
export const GET = handle((req: Request) => getRoster(getApiDeps(), req));
