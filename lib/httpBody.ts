// Čtení těla požadavku s tvrdým stropem. Content-Length odesílatel může
// zamlčet (chunked) nebo zkreslit, proto se tělo čte po částech a čtení se
// přeruší, jakmile strop překročí. Volat až PO autentizaci, ať anonymní
// požadavek nic nečte.

export type BodyRead = { ok: true; text: string } | { ok: false; status: number; error: string }

type BytesRead = { ok: true; bytes: Uint8Array } | { ok: false; status: number; error: string }

async function readLimitedBytes(req: Request, maxBytes: number): Promise<BytesRead> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413, error: 'payload_too_large' }
  if (!req.body) return { ok: false, status: 400, error: 'invalid_json' }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      return { ok: false, status: 413, error: 'payload_too_large' }
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength }
  return { ok: true, bytes: all }
}

export async function readLimitedBody(req: Request, maxBytes: number): Promise<BodyRead> {
  const read = await readLimitedBytes(req, maxBytes)
  if (!read.ok) return read
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) }
  } catch {
    return { ok: false, status: 400, error: 'invalid_encoding' }
  }
}

/** Formulářové tělo (urlencoded i multipart) se stropem; null = příliš velké nebo nečitelné. */
export async function readLimitedFormData(req: Request, maxBytes: number): Promise<FormData | null> {
  const read = await readLimitedBytes(req, maxBytes)
  if (!read.ok) return null
  try {
    return await new Response(read.bytes as BodyInit, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData()
  } catch {
    return null
  }
}

/** Strop těla zápisových REST rout (/api/v1). Texty mají vlastní limity ve validaci; tohle je jen zábrana proti obřímu tělu. */
export const API_JSON_BODY_MAX_BYTES = 256 * 1024

/** Tělo jako JSON, se stropem. Chyba nese HTTP status a kód pro odpověď. */
export async function readJsonBody(
  req: Request,
  maxBytes: number = API_JSON_BODY_MAX_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const body = await readLimitedBody(req, maxBytes)
  if (!body.ok) return body
  try {
    return { ok: true, value: JSON.parse(body.text) }
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' }
  }
}
