import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngInfo {
  width: number;
  height: number;
  /** An alpha channel (color type 4 or 6) or a tRNS transparency chunk. App Store icons can't have either. */
  alpha: boolean;
}

/** Reads a PNG's size and whether it can be transparent, from its header chunks. Undefined if it isn't a PNG. */
export function readPng(bytes: Buffer): PngInfo | undefined {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25]!;
  let alpha = colorType === 4 || colorType === 6;
  // tRNS must come before the first IDAT; stop there.
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "tRNS") alpha = true;
    if (type === "IDAT" || type === "IEND") break;
    offset += 12 + length;
  }
  return { width, height, alpha };
}

/**
 * The lowest alpha value in an 8- or 16-bit RGBA or grey+alpha PNG (255 means every pixel is opaque). Undefined when
 * that can't be told cheaply: interlaced images, palettes, or a broken file.
 */
export function minAlpha(bytes: Buffer): number | undefined {
  const info = readPng(bytes);
  if (!info) return undefined;
  const depth = bytes[24]!;
  const colorType = bytes[25]!;
  const interlace = bytes[28]!;
  if (!(colorType === 6 || colorType === 4) || interlace !== 0 || (depth !== 8 && depth !== 16)) return undefined;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") break;
    offset += 12 + length;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(chunks));
  } catch {
    return undefined;
  }
  const channels = colorType === 6 ? 4 : 2;
  const bpp = channels * (depth / 8);
  const stride = info.width * bpp;
  if (raw.length < (stride + 1) * info.height) return undefined;
  let prev = Buffer.alloc(stride);
  let min = 255;
  for (let y = 0; y < info.height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = (line[x]! + add) & 255;
    }
    // The alpha sample is the last one of each pixel; for 16-bit, its high byte is enough.
    for (let x = bpp - depth / 8; x < stride; x += bpp) if (line[x]! < min) min = line[x]!;
    prev = line;
  }
  return min;
}
