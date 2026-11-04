/** Decodes a .strings file, which Xcode may save as UTF-16 (with a byte order mark) or UTF-8. */
export function decodeStrings(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.toString("utf8").replace(/^﻿/, "");
}

const UNESCAPE: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };

/** `"key" = "value";` pairs of an old-style .strings file; keys may be unquoted. Comments are skipped. */
export function parseStrings(input: Buffer | string): Record<string, string> {
  const text = (typeof input === "string" ? input : decodeStrings(input)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: Record<string, string> = {};
  const re = /(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_.-]+))\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g;
  for (const m of text.matchAll(re)) {
    const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => UNESCAPE[c] ?? c);
    out[unescape(m[1] ?? m[2]!)] = unescape(m[3]!);
  }
  return out;
}
