import type { NextConfig } from 'next'
import path from 'node:path'
import { legacyRedirectConfig } from './lib/web/redirects'

const nextConfig: NextConfig = {
  // node_modules je symlink do sdíleného stromu (samostatná vývojová kopie webu);
  // Turbopack musí smět číst i mimo složku projektu.
  turbopack: { root: path.resolve(__dirname, '..') },
  images: {
    formats: ['image/avif', 'image/webp'],
    // Next 16: qualities je povinný allowlist. 75 = výchozí, 85 = hero.
    qualities: [60, 75, 85],
    deviceSizes: [360, 480, 640, 750, 828, 1080, 1280, 1600, 1920, 2560],
    imageSizes: [64, 96, 128, 256, 320],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  poweredByHeader: false,
  // Staré URL (Wix, cs.mummiesdaddies.com) → nový web, podle strategy.redirects.
  async redirects() {
    return legacyRedirectConfig()
  },
}

export default nextConfig
