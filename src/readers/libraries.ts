import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findFiles, findPackageDir, isDir, readJson } from "../core/fs.js";
import type { NativeLibrary } from "../core/types.js";
import { readManifest } from "./android.js";

const hasPodspec = (dir: string) =>
  [dir, join(dir, "ios")].some((d) => isDir(d) && readdirSync(d).some((name) => name.endsWith(".podspec")));

const hasAndroid = (dir: string) =>
  existsSync(join(dir, "android", "build.gradle")) || existsSync(join(dir, "android", "build.gradle.kts"));

/**
 * The packages autolinking would link: every name in dependencies, devDependencies and peerDependencies that is
 * installed and ships a podspec or an android/ build. react-native.config.js overrides aren't applied (that needs
 * running the app's JS); doctor says so when the file exists.
 */
export function readLibraries(root: string, declared: Record<string, string>): NativeLibrary[] {
  const libraries: NativeLibrary[] = [];
  for (const name of Object.keys(declared).sort()) {
    const dir = findPackageDir(root, name);
    if (!dir) continue;
    const ios = hasPodspec(dir);
    const android = hasAndroid(dir);
    if (!ios && !android) continue;
    const manifestFile = join(dir, "android", "src", "main", "AndroidManifest.xml");
    libraries.push({
      name,
      version: readJson(join(dir, "package.json")).version,
      dir,
      ios,
      android,
      privacyManifests: ios ? findFiles(dir, (file) => file === "PrivacyInfo.xcprivacy") : [],
      ...(android && existsSync(manifestFile) ? { androidManifest: readManifest(manifestFile, "main") } : {}),
    });
  }
  return libraries;
}
