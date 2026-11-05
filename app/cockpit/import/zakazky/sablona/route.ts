import { NextResponse } from 'next/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { CSV_TEMPLATE, CSV_TEMPLATE_FILENAME } from '@/domain/crm/bulkImport'

// Šablona tabulky pro hromadný import zakázek (docs/PROVOZ.md). Statický
// text s vymyšlenými příklady; přesto jen pro obchodní role s AAL2, ať se stránka
// neukazuje cizím. BOM na začátku, aby Excel poznal UTF-8 a neuměl rozbít háčky.
export async function GET() {
  const user = await tryRequireUser({ aal2: true })
  if (!user || !memberSeesSales((await getCurrentMember()).member)) return new NextResponse(null, { status: 404 })
  return new NextResponse(`﻿${CSV_TEMPLATE}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${CSV_TEMPLATE_FILENAME}"`,
      'cache-control': 'no-store',
    },
  })
}
