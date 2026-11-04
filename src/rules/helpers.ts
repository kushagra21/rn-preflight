import { lineOf } from "../core/fs.js";
import type { IosProject } from "../core/types.js";
import type { PlistValue } from "../readers/plist.js";

/** Where an Info.plist key is written: its line in Info.plist, or the build setting that sets it. */
export function infoKeyLocation(ios: IosProject, key: string): { file?: string; line?: number } {
  const info = ios.infoPlist;
  if (!info) return {};
  if (info.keysFromBuildSettings.includes(key) && !info.file.endsWith(".plist")) {
    return { file: info.file, line: lineOf(info.file, `INFOPLIST_KEY_${key}`) };
  }
  return { file: info.file, line: lineOf(info.file, `<key>${key}</key>`) };
}

export const infoValue = (ios: IosProject, key: string): PlistValue | undefined => ios.infoPlist?.values[key];

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
