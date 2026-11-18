/**
 * OCR for scanned documents and photos, entirely on this server (tesseract.js + local French and
 * English language data): no document leaves the server to be read.
 *
 * One worker, created on first use and reused; pages are recognised one at a time so a burst of
 * uploads cannot exhaust memory. Images are normalised first (orientation, grayscale, contrast,
 * small images enlarged) and size-limited against decompression bombs.
 */
import { copyFileSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { createWorker, type Worker } from 'tesseract.js'

const require = createRequire(import.meta.url)

/** Largest image accepted, in pixels (a 12 MP photo is 4000 × 3000). */
export const MAX_INPUT_PIXELS = 50_000_000

export interface OcrResult {
  text: string
  /** Mean word confidence, 0–100. */
  confidence: number
}

export class OcrError extends Error {}

let worker: Promise<Worker> | null = null
let queue: Promise<unknown> = Promise.resolve()
let langDir: string | null = null

/**
 * tesseract.js reads every language from one directory, but each language package has its own
 * (<package>/4.0.0_best_int/<lang>.traineddata.gz). Copy both once into a private temp folder.
 */
function languageDir(): string {
  if (langDir) return langDir
  const source = (lang: string) => join(dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), '4.0.0_best_int', `${lang}.traineddata.gz`)
  const dir = mkdtempSync(join(tmpdir(), 'akili-ocr-'))
  for (const lang of ['fra', 'eng']) copyFileSync(source(lang), join(dir, `${lang}.traineddata.gz`))
  langDir = dir
  return dir
}

async function getWorker(): Promise<Worker> {
  if (!worker) {
    // French first, English as a fallback. Language data is local: nothing is downloaded.
    worker = createWorker(['fra', 'eng'], 1, {
      langPath: languageDir(), cacheMethod: 'none', gzip: true, logger: () => undefined, errorHandler: () => undefined,
    }).then(async w => {
      // Images rarely carry a resolution; tell tesseract what prepareImage produces (about 200 dpi for A4).
      await w.setParameters({ user_defined_dpi: '200' })
      return w
    }).catch(error => { worker = null; throw error })
  }
  return worker
}

/** Normalise any supported image (PNG, JPEG, WebP, rendered PDF page) into a PNG tesseract reads well. */
export async function prepareImage(bytes: Buffer): Promise<Buffer> {
  let image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
  let meta
  try { meta = await image.metadata() } catch { throw new OcrError('Image illisible.') }
  if (!meta.width || !meta.height) throw new OcrError('Image illisible.')
  image = image.rotate() // EXIF orientation (phone photos)
  const longest = Math.max(meta.width, meta.height)
  // Text in small images is too thin for OCR; very large photos only cost time.
  if (longest < 1600) image = image.resize({ width: meta.width >= meta.height ? 1600 : undefined, height: meta.height > meta.width ? 1600 : undefined, kernel: 'lanczos3' })
  else if (longest > 4200) image = image.resize({ width: meta.width >= meta.height ? 4200 : undefined, height: meta.height > meta.width ? 4200 : undefined })
  return image.grayscale().normalize().png().toBuffer()
}

const PAGE_TIMEOUT_MS = 90_000

/** Recognise one image. Runs after the previous recognition finished. */
export function recognize(bytes: Buffer): Promise<OcrResult> {
  const run = queue.then(async () => {
    const png = await prepareImage(bytes)
    const w = await getWorker()
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        w.recognize(png),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OcrError('Lecture trop longue (délai dépassé).')), PAGE_TIMEOUT_MS) }),
      ])
      return { text: result.data.text.replace(/\r/g, '').trim(), confidence: Math.round(result.data.confidence ?? 0) }
    } catch (error) {
      if (error instanceof OcrError) {
        // A stuck worker is replaced for the next page.
        void shutdownOcr()
        throw error
      }
      throw new OcrError(`Lecture impossible : ${(error as Error).message ?? String(error)}`.slice(0, 200))
    } finally {
      if (timer) clearTimeout(timer)
    }
  })
  queue = run.catch(() => undefined)
  return run
}

export async function shutdownOcr(): Promise<void> {
  const current = worker
  worker = null
  if (current) await current.then(w => w.terminate()).catch(() => undefined)
}
