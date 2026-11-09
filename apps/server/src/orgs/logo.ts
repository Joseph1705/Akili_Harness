/** Organization logo (directive 5.3): PNG/JPEG/WebP ≤ 2 MB, checked by bytes, re-encoded without metadata. SVG refused. */
import sharp from 'sharp'
import { badRequest } from '../errors.js'
import { sniff } from '../storage/sniff.js'

export const LOGO_MAX_BYTES = 2 * 1024 * 1024
export const LOGO_SIZES = [32, 64, 128, 512] as const

export async function normalizeLogo(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > LOGO_MAX_BYTES) throw badRequest('Logo trop lourd (2 Mo maximum).')
  const kind = sniff(bytes)
  if (kind !== 'png' && kind !== 'jpeg' && kind !== 'webp') throw badRequest('Formats acceptés : PNG, JPG ou WebP.')
  try {
    // Re-encoding drops EXIF, ICC comments and any trailing payload; output is a plain 512 px PNG.
    return await sharp(bytes, { limitInputPixels: 25_000_000 })
      .rotate()
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
  } catch {
    throw badRequest('Image illisible.')
  }
}

export async function logoAtSize(png512: Buffer, size: number): Promise<Buffer> {
  return sharp(png512).resize(size, size).png().toBuffer()
}
