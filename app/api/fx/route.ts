import { NextResponse } from 'next/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { czkPerEur } from '@/connectors/cnb'

// GET /api/fx → aktuální kurz Kč za 1 EUR (živý ČNB fixing), pro náhled v
// DealForm při zadávání částky v eurech. Finální přepočet dělá server
// action znovu sám při uložení — tohle je jen UI náhled.
export async function GET() {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  try {
    const rate = await czkPerEur()
    return NextResponse.json({ czkPerEur: rate })
  } catch {
    return NextResponse.json({ error: 'fx_unavailable' }, { status: 502 })
  }
}
