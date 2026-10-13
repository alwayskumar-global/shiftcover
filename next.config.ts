import type { NextConfig } from 'next';

const workerPrivacyHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Cache-Control', value: 'no-store' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The /review harness lives in *.review.tsx files, which only count as pages when UI_REVIEW=true at build or dev
  // start. A normal (production) build never compiles them in, so no review route or fixture ships.
  pageExtensions: process.env.UI_REVIEW === 'true' ? ['tsx', 'ts', 'review.tsx'] : ['tsx', 'ts'],
  serverExternalPackages: ['pg', 'pg-boss'],
  // PLAN.md 2: worker link pages and APIs must never leak the token via Referer or be indexed.
  async headers() {
    return [
      { source: '/c/:path*', headers: workerPrivacyHeaders },
      { source: '/api/c/:path*', headers: workerPrivacyHeaders },
      { source: '/api/w/:path*', headers: workerPrivacyHeaders },
    ];
  },
};

export default nextConfig;
