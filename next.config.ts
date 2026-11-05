import type { NextConfig } from "next";
import { legacyRedirectConfig } from "./lib/web/redirects";

/**
 * Security headers for every route.
 *
 * CSP is shipped in two layers:
 *  1. ENFORCED_CSP — the full policy, sent as Content-Security-Policy
 *     (enforced since 2026-09-29). Violations are blocked AND reported.
 *  2. REPORT_ONLY_CSP — a stricter candidate, sent as
 *     Content-Security-Policy-Report-Only. Blocks nothing; its reports show
 *     whether the next tightening step would break anything.
 *
 * Why enforcing the full policy is safe (checked in code, see
 * test/security-headers.test.ts):
 *  - no browser Supabase client exists (lib/supabase/env.ts): auth, data and
 *    storage run server-side, the browser only talks to 'self' (RSC, Server
 *    Actions); Supabase origins stay in connect-src only as a harmless
 *    fallback;
 *  - Turnstile needs exactly script-src + frame-src
 *    https://challenges.cloudflare.com (Cloudflare docs); connect-src too,
 *    to be safe;
 *  - fonts are self-hosted (/fonts, @font-face in app/globals.css), images
 *    are /logo.svg and the MFA QR code (data: URL from Supabase);
 *  - Next.js inline bootstrap scripts and styles are covered by
 *    'unsafe-inline' (no nonces), 'unsafe-eval' only in `next dev`;
 *  - OAuth consent redirects: see form-action below; links to Microsoft
 *    login, SharePoint and signed PDF URLs are navigations, not governed
 *    by CSP;
 *  - Vercel preview toolbar (vercel.live) is allowed only when
 *    VERCEL_ENV=preview, production never loads it.
 *
 * Next step (REPORT_ONLY_CSP): once its reports stay empty, promote its
 * extra directives into ENFORCED_CSP. Dropping 'unsafe-inline' from
 * script-src needs per-request nonces generated in proxy.ts (see
 * node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md),
 * which forces dynamic rendering — a separate decision.
 *
 * form-action: approveOAuth (app/api/oauth/authorize) redirects to the OAuth
 * client's registered redirect_uri, which may be any https origin or a
 * loopback URL. Chrome applies form-action to redirects after a native form
 * submit, so it allows https: and loopback in addition to 'self'.
 */

const isDev = process.env.NODE_ENV !== "production";
// Vercel sets VERCEL_ENV at build time (production | preview | development).
const isVercelPreview = process.env.VERCEL_ENV === "preview";
// upgrade-insecure-requests only on Vercel (always https); a local
// `next start` over plain http would otherwise get its subresources upgraded.
const isVercel = Boolean(process.env.VERCEL);

const TURNSTILE = "https://challenges.cloudflare.com";

// Vercel Toolbar on preview deployments (Vercel docs, "Using a Content
// Security Policy" with the toolbar). Never part of the production policy.
const VERCEL_LIVE = isVercelPreview
  ? {
      script: ["https://vercel.live"],
      connect: ["https://vercel.live", "wss://ws-us3.pusher.com"],
      img: ["https://vercel.live", "https://vercel.com"],
      frame: ["https://vercel.live"],
      style: ["https://vercel.live"],
      font: ["https://vercel.live", "https://assets.vercel.com"],
    }
  : { script: [], connect: [], img: [], frame: [], style: [], font: [] };

function supabaseOrigins(): string[] {
  const raw = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return [];
  try {
    const u = new URL(raw);
    return [u.origin, `wss://${u.host}`];
  } catch {
    return [];
  }
}

const FORM_ACTION =
  "form-action 'self' https: http://localhost:* http://127.0.0.1:*";

// Reporting target for both policies: `report-uri` is the legacy directive
// (still needed for Safari/Firefox, which don't implement the Reporting API),
// `report-to csp` is the modern one, matched to the Reporting-Endpoints
// header below. Both point at the same unauthenticated route handler; see
// app/api/csp-report/route.ts (it logs the disposition: "enforce" = blocked,
// "report" = would be blocked by the stricter candidate).
const REPORT_ENDPOINT = "/api/csp-report";
const REPORTING = [`report-uri ${REPORT_ENDPOINT}`, "report-to csp"];

const join = (...parts: (string | false)[]) => parts.filter(Boolean).join(" ");

export const ENFORCED_CSP = [
  "default-src 'self'",
  // Next.js injects inline bootstrap scripts; without nonces they need 'unsafe-inline'.
  join("script-src 'self' 'unsafe-inline'", TURNSTILE, ...VERCEL_LIVE.script, isDev && "'unsafe-eval'"),
  join("style-src 'self' 'unsafe-inline'", ...VERCEL_LIVE.style),
  join("img-src 'self' data: blob:", ...VERCEL_LIVE.img),
  join("font-src 'self' data:", ...VERCEL_LIVE.font),
  join("connect-src 'self'", TURNSTILE, ...supabaseOrigins(), ...VERCEL_LIVE.connect, isDev && "ws:"),
  join("frame-src", TURNSTILE, ...VERCEL_LIVE.frame),
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  FORM_ACTION,
  ...(isVercel && !isDev ? ["upgrade-insecure-requests"] : []),
  ...REPORTING,
].join("; ");

// Stricter candidate (report-only): what the enforced policy should become.
//  - connect-src without Supabase origins (no browser Supabase client);
//  - img-src without blob:, worker-src 'none' (nothing creates workers);
//  - script-src-attr 'none' (no inline on*="…" handlers; React attaches
//    events in JS, not as attributes).
// Everything else equals ENFORCED_CSP.
export const REPORT_ONLY_CSP = [
  "default-src 'self'",
  join("script-src 'self' 'unsafe-inline'", TURNSTILE, ...VERCEL_LIVE.script, isDev && "'unsafe-eval'"),
  "script-src-attr 'none'",
  join("style-src 'self' 'unsafe-inline'", ...VERCEL_LIVE.style),
  join("img-src 'self' data:", ...VERCEL_LIVE.img),
  join("font-src 'self' data:", ...VERCEL_LIVE.font),
  join("connect-src 'self'", TURNSTILE, ...VERCEL_LIVE.connect, isDev && "ws:"),
  join("frame-src", TURNSTILE, ...VERCEL_LIVE.frame),
  "worker-src 'none'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  FORM_ACTION,
  ...(isVercel && !isDev ? ["upgrade-insecure-requests"] : []),
  ...REPORTING,
].join("; ");

// Reporting API endpoint group, referenced by `report-to csp` above.
// https://developer.chrome.com/docs/capabilities/web-apis/reporting-api
export const REPORTING_ENDPOINTS = `csp="${REPORT_ENDPOINT}"`;

export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "hid=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "display-capture=()",
  "interest-cohort=()",
  "browsing-topics=()",
].join(", ");

export const securityHeaders: { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: ENFORCED_CSP },
  { key: "Content-Security-Policy-Report-Only", value: REPORT_ONLY_CSP },
  { key: "Reporting-Endpoints", value: REPORTING_ENDPOINTS },
];

const nextConfig: NextConfig = {
  turbopack: { root: "/home/user" }, // DOČASNĚ jen pro lokální build (symlink node_modules)
  poweredByHeader: false,
  // Obrázky veřejného webu (public/web/photos, next/image). Next 16:
  // qualities je povinný allowlist; 75 = výchozí, 85 = hero (lib/web/photos.ts).
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [60, 75, 85],
    deviceSizes: [360, 480, 640, 750, 828, 1080, 1280, 1600, 1920, 2560],
    imageSizes: [64, 96, 128, 256, 320],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  // Staré URL webu (Wix, cs.mummiesdaddies.com) → nový web, 301 (lib/web/redirects.ts).
  async redirects() {
    return legacyRedirectConfig();
  },
  // Server Actions mají ve výchozím stavu tělo požadavku nejvýš 1 MB, takže PDF
  // nabídky nad 1 MB (import nabídky i hromadný import zakázek) by se ani
  // nedostalo k akci. 4 MB je pod limitem Vercelu (4,5 MB); hromadný import
  // posílá vždy jedno PDF na jedno volání (BULK_MAX_PDF_BYTES).
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
