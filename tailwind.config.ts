import type { Config } from 'tailwindcss'
import { webTailwindExtend } from './lib/web/tokens'

// Tokeny webu žijí v lib/web/tokens.ts. Při přenosu do hlavního systému stačí
// přidat cesty níže do `content` a spreadnout webTailwindExtend do theme.extend.
export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/web/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      ...webTailwindExtend,
    },
  },
} satisfies Config
