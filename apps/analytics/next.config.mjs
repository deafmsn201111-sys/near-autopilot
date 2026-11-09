import path from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Trace dependencies from the monorepo root so workspace packages land in the standalone bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  reactStrictMode: true,
  // Next 15.5.x dev-tools segment explorer throws an RSC-manifest error in dev (dev-only, absent from
  // production builds). Disable it so `next dev` stays clean.
  experimental: { devtoolSegmentExplorer: false },
  poweredByHeader: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@near-autopilot/core', '@near-autopilot/config'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
