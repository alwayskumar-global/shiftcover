import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/auth';

export const dynamic = 'force-dynamic';

// Better Auth endpoints: /api/auth/sign-in/email, /api/auth/sign-in/magic-link, /api/auth/magic-link/verify, ...
export const GET = (req: Request) => toNextJsHandler(getAuth()).GET(req);
export const POST = (req: Request) => toNextJsHandler(getAuth()).POST(req);
