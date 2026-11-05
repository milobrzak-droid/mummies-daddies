'use client'

import { useEffect } from 'react'

// Náhrada celého kořenového layoutu: globals.css tu není načtené, proto
// inline styly s hodnotami tokenů (docs/PROVOZ.md): plocha #F3F4F6,
// grafit #17202E, tichý text #5A6472, hrana #E5E8ED, koral s grafitovým
// textem (kontrast ≥4,5:1). Vzhled odpovídá StatusPanel.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <html lang="cs">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          boxSizing: 'border-box',
          background: '#F3F4F6',
          color: '#17202E',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, system-ui, sans-serif",
        }}
      >
        <div
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: '16px',
            width: '100%',
            maxWidth: '448px',
            padding: '32px',
            boxSizing: 'border-box',
            background: '#FFFFFF',
            border: '1px solid #E5E8ED',
            borderRadius: '22px',
            boxShadow: '0 1px 2px rgba(23,32,46,.04), 0 4px 16px -6px rgba(23,32,46,.07)',
          }}
        >
          <p
            style={{
              fontSize: '11px',
              fontWeight: 500,
              fontFamily: "'Fira Mono', ui-monospace, Menlo, monospace",
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: '#5A6472',
              margin: 0,
            }}
          >
            Chyba
          </p>
          <h1 style={{ fontFamily: 'system-ui, sans-serif', fontSize: '24px', fontWeight: 700, lineHeight: 1.17, letterSpacing: '-0.015em', margin: 0 }}>
            Něco se pokazilo.
          </h1>
          <p style={{ fontSize: '14px', color: '#5A6472', margin: 0 }}>
            Aplikaci se nepodařilo načíst. Zkus to znovu.
          </p>
          {error.digest && (
            <p style={{ fontSize: '12px', color: '#5A6472', margin: 0 }}>
              Kód chyby: <span style={{ fontFamily: 'monospace' }}>{error.digest}</span>
            </p>
          )}
          <button
            onClick={() => retry()}
            style={{
              marginTop: '8px',
              minHeight: '44px',
              borderRadius: '999px',
              background: '#FF5A5F',
              color: '#17202E',
              border: 'none',
              padding: '0 18px',
              fontSize: '14px',
              fontWeight: 650,
              cursor: 'pointer',
            }}
          >
            Zkusit znovu
          </button>
        </div>
      </body>
    </html>
  )
}
