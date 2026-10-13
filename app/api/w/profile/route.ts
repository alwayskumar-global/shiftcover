import { getApiDeps } from '@/api/deps';
import { getWorkerProfile, patchWorkerProfile } from '@/api/handlers';
import { handle } from '@/api/http';

export const dynamic = 'force-dynamic';
export const GET = handle((req: Request) => getWorkerProfile(getApiDeps(), req));
export const PATCH = handle((req: Request) => patchWorkerProfile(getApiDeps(), req));
