// Vygeneruje lib/web/data/photo-blur.json: malé rozmazané náhledy fotek (data URL, ~0,4 kB),
// které next/image ukáže jako placeholder="blur", než se líně načte skutečná fotka.
// Spuštění: node scripts/web/photo-blur.mjs (po změně fotek v public/web/photos).
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const dir = path.join(root, 'public/web/photos')
const out = {}
for (const f of fs.readdirSync(dir).sort()) {
  if (!/\.(jpe?g|png|webp)$/i.test(f) || /-1200\./.test(f)) continue
  const buf = await sharp(path.join(dir, f)).resize(16, 16, { fit: 'inside' }).blur(0.6).jpeg({ quality: 50 }).toBuffer()
  out[`/web/photos/${f}`] = `data:image/jpeg;base64,${buf.toString('base64')}`
}
fs.writeFileSync(path.join(root, 'lib/web/data/photo-blur.json'), JSON.stringify(out, null, 0) + '\n')
console.log(Object.keys(out).length, 'náhledů')
