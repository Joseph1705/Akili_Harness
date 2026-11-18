/**
 * Office files (DOCX, XLSX) are zip archives. A tiny file can expand to gigabytes ("zip bomb"):
 * the directory is read first and the file is refused before anything is decompressed when it
 * declares too many entries, too much uncompressed data, or an absurd compression ratio.
 */
import JSZip from 'jszip'

export class UnsafeArchive extends Error {}

export interface ZipLimits {
  maxEntries: number
  maxUncompressedBytes: number
  maxRatio: number
}

export const OFFICE_LIMITS: ZipLimits = { maxEntries: 2_000, maxUncompressedBytes: 60 * 1024 * 1024, maxRatio: 200 }

interface EntryData { uncompressedSize?: number; compressedSize?: number }

export async function openSafeZip(bytes: Buffer, limits: ZipLimits = OFFICE_LIMITS): Promise<JSZip> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  } catch {
    throw new UnsafeArchive('Archive illisible.')
  }
  const entries = Object.values(zip.files)
  if (entries.length > limits.maxEntries) throw new UnsafeArchive('Trop de fichiers dans le document.')
  let total = 0
  for (const entry of entries) {
    // JSZip keeps the sizes declared in the central directory before decompressing.
    const data = (entry as unknown as { _data?: EntryData })._data
    const size = data?.uncompressedSize ?? 0
    const packed = data?.compressedSize ?? 0
    if (!Number.isFinite(size) || size < 0) throw new UnsafeArchive('Archive invalide.')
    total += size
    if (packed > 0 && size / packed > limits.maxRatio && size > 1024 * 1024) throw new UnsafeArchive('Document anormalement compressé, refusé par sécurité.')
  }
  if (total > limits.maxUncompressedBytes) throw new UnsafeArchive('Document trop volumineux une fois décompressé.')
  return zip
}
