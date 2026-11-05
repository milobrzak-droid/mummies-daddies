'use client'
import { useEffect } from 'react'

// Minimal shape of the global the Cloudflare Turnstile script attaches.
// We only ever call `render`, and only as a fallback if the script's own
// data-attribute auto-render (see below) hasn't already picked up the div.
declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: { sitekey: string }) => string
    }
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'

/**
 * Renders a Cloudflare Turnstile widget inside the surrounding <form>.
 * Turnstile auto-creates a hidden input named "cf-turnstile-response" that
 * ships with the form submission — the server action reads that directly.
 *
 * Degrades to rendering nothing when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset,
 * so login keeps working unchanged until Turnstile is actually configured.
 */
export function Turnstile() {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

  useEffect(() => {
    if (!siteKey) return
    if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      // Script already present (e.g. from a previous mount) — if the API is
      // ready but this widget's div hasn't been picked up yet, render it.
      window.turnstile?.render('.cf-turnstile', { sitekey: siteKey })
      return
    }
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    document.head.appendChild(script)
  }, [siteKey])

  if (!siteKey) return null

  return <div className="cf-turnstile flex justify-center" data-sitekey={siteKey} />
}
