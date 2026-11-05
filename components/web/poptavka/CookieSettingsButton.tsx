'use client'

import { buttonClasses } from '../Button'

/**
 * „Nastavit cookies“ na /cookies. Lišta souhlasu (CMP) zatím neexistuje,
 * proto tlačítko jen vyšle událost `md:cookie-settings`, na kterou se lišta
 * po doplnění nástroje napojí (window.addEventListener('md:cookie-settings', …)).
 */
export const COOKIE_SETTINGS_EVENT = 'md:cookie-settings'

export function CookieSettingsButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(COOKIE_SETTINGS_EVENT))}
      className={buttonClasses({ variant: 'outline', size: 'md' })}
    >
      {label}
    </button>
  )
}
