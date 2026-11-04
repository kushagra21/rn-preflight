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
