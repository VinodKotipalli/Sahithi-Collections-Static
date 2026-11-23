/**
 * Browser-side image compression for the Firebase-only admin path.
 *
 * In that mode uploaded photos are stored inline as `data:` URLs inside
 * Firestore documents, which are capped at 1 MiB. These helpers shrink images
 * on upload and, before a document is written, re-encode inline images until
 * the whole payload fits a byte budget.
 */

/** Safe budget for a single Firestore document (hard limit is 1,048,576 bytes). */
export const FIRESTORE_DOC_BUDGET_BYTES = 900_000;

interface EncodeStep {
  maxDim: number;
  quality: number;
}

/** Progressively smaller encodings tried when a payload is over budget. */
const ENCODE_STEPS: EncodeStep[] = [
  { maxDim: 1600, quality: 0.82 },
  { maxDim: 1400, quality: 0.78 },
  { maxDim: 1200, quality: 0.74 },
  { maxDim: 1024, quality: 0.7 },
  { maxDim: 900, quality: 0.66 },
  { maxDim: 800, quality: 0.62 },
  { maxDim: 640, quality: 0.6 },
  { maxDim: 520, quality: 0.55 },
];

/** Per-image ceiling applied at upload time (base64 characters). */
const UPLOAD_MAX_DATA_URL_CHARS = 220_000;

function canEncodeInBrowser(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof Image !== 'undefined' &&
    typeof document.createElement === 'function'
  );
}

function isInlineImage(val: unknown): val is string {
  return typeof val === 'string' && val.startsWith('data:image/');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image for compression.'));
    img.src = src;
  });
}

let webpSupported: boolean | null = null;
function supportsWebp(): boolean {
  if (webpSupported === null) {
    try {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      webpSupported = c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      webpSupported = false;
    }
  }
  return webpSupported;
}

function encode(img: HTMLImageElement, step: EncodeStep): string {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, step.maxDim / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');
  const mime = supportsWebp() ? 'image/webp' : 'image/jpeg';
  if (mime === 'image/jpeg') {
    // JPEG has no alpha; paint white so transparent PNGs don't turn black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mime, step.quality);
}

/** Re-encode a data URL at the given step; never returns something larger than the input. */
async function reencode(dataUrl: string, step: EncodeStep): Promise<string> {
  if (!canEncodeInBrowser()) return dataUrl;
  try {
    const img = await loadImage(dataUrl);
    const out = encode(img, step);
    return out.length < dataUrl.length ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}

/**
 * Compress a freshly uploaded image data URL so a single photo stays well
 * below the Firestore document limit.
 */
export async function compressUploadDataUrl(dataUrl: string): Promise<string> {
  if (!canEncodeInBrowser() || !isInlineImage(dataUrl)) return dataUrl;
  let current = dataUrl;
  for (const step of ENCODE_STEPS) {
    current = await reencode(dataUrl, step);
    if (current.length <= UPLOAD_MAX_DATA_URL_CHARS) break;
  }
  return current;
}

function collectInlineImagePaths(
  node: unknown,
  path: Array<string | number>,
  out: Array<Array<string | number>>
): void {
  if (isInlineImage(node)) {
    out.push(path);
  } else if (Array.isArray(node)) {
    node.forEach((child, i) => collectInlineImagePaths(child, [...path, i], out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectInlineImagePaths(v, [...path, k], out);
    }
  }
}

function getAt(root: unknown, path: Array<string | number>): unknown {
  return path.reduce<unknown>(
    (acc, key) => (acc == null ? acc : (acc as Record<string | number, unknown>)[key]),
    root
  );
}

function setAt(root: unknown, path: Array<string | number>, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]] = value;
}

/** Approximate Firestore document size (UTF-8 bytes of the JSON payload). */
export function estimateDocBytes(data: unknown): number {
  const json = JSON.stringify(data) ?? '';
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(json).length : json.length;
}

export class DocumentTooLargeError extends Error {
  constructor(public readonly bytes: number, public readonly budget: number) {
    super(
      `This content is too large to save (${Math.round(bytes / 1024)} KB, limit ` +
        `${Math.round(budget / 1024)} KB) even after compressing its photos. ` +
        'Remove a few photos (for example some lookbook entries) and try again.'
    );
    this.name = 'DocumentTooLargeError';
  }
}

/**
 * Returns a deep copy of `data` whose inline `data:image/...` strings have been
 * re-encoded (progressively smaller) until the whole object fits `budget`.
 * Non-inline URLs are untouched. Throws DocumentTooLargeError if it can't fit.
 */
export async function fitInlineImagesToBudget<T>(
  data: T,
  budget: number = FIRESTORE_DOC_BUDGET_BYTES
): Promise<T> {
  if (estimateDocBytes(data) <= budget) return data;

  const paths: Array<Array<string | number>> = [];
  collectInlineImagePaths(data, [], paths);
  if (paths.length === 0 || !canEncodeInBrowser()) {
    throw new DocumentTooLargeError(estimateDocBytes(data), budget);
  }

  const originals = paths.map((p) => getAt(data, p) as string);
  const working = structuredClone(data);

  for (const step of ENCODE_STEPS) {
    // Re-encode from the original each time to avoid compounding artifacts.
    const encoded = await Promise.all(originals.map((src) => reencode(src, step)));
    paths.forEach((p, i) => setAt(working, p, encoded[i]));
    if (estimateDocBytes(working) <= budget) return working;
  }

  throw new DocumentTooLargeError(estimateDocBytes(working), budget);
}
