import type { NextConfig } from 'next';

const workerPrivacyHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Cache-Control', value: 'no-store' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
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
