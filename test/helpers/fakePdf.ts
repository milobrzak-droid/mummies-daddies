// Minimální „PDF" pro testy nabídky z přílohy e-mailu: hlavička, stránkový
// strom s daným počtem stran a volitelný text, který se pozná v uložených datech.
export function fakePdf(opts: { pages?: number; encrypted?: boolean; marker?: string; pad?: number } = {}): Uint8Array<ArrayBuffer> {
  const pages = opts.pages ?? 2
  const parts = [
    '%PDF-1.4',
    `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`,
    `2 0 obj << /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${pages} >> endobj`,
    ...Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`),
    opts.marker ? `% ${opts.marker}` : '',
    opts.encrypted ? 'trailer << /Root 1 0 R /Encrypt 9 0 R >>' : 'trailer << /Root 1 0 R >>',
    '%%EOF',
    ' '.repeat(opts.pad ?? 0),
  ]
  return new TextEncoder().encode(parts.join('\n'))
}
