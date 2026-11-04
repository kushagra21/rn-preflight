import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { UserError } from "../core/errors.js";
import { findPackageDir, isDir, readJson } from "../core/fs.js";
import type { Platform, Project } from "../core/types.js";
import { readAndroid, type AndroidOptions } from "./android.js";
import { readIos, type IosOptions } from "./ios.js";
import { readLibraries } from "./libraries.js";

export interface ReadOptions extends IosOptions, AndroidOptions {
  platforms?: Platform[];
}

/** Reads everything the rules look at. Throws UserError when the project can't be read at all. */
export function readProject(cwd: string, options: ReadOptions = {}): Project {
  const root = resolve(cwd);
  const pkgFile = join(root, "package.json");
  if (!existsSync(pkgFile)) throw new UserError(`No package.json in ${root}. Run rn-preflight from your app's root folder, or pass --cwd.`);
  const pkg = readJson(pkgFile);
  const declared: Record<string, string> = { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies };

  // Bare apps often use Expo modules (expo is a dependency) but keep ios/ and android/ in the repository. Only an app
  // with neither folder is managed by Expo's prebuild, which rn-preflight can't read yet.
  if ("expo" in declared && !isDir(join(root, "ios")) && !isDir(join(root, "android"))) {
    throw new UserError("This Expo app has no ios/ or android/ folder (Expo generates them with prebuild). rn-preflight reads native projects, so run `npx expo prebuild` first, or wait for Expo support.");
  }
  const rnDir = findPackageDir(root, "react-native");
  if (!rnDir) {
    throw new UserError("react-native" in declared ? "react-native isn't installed. Install your dependencies first." : `${pkgFile} doesn't depend on react-native.`);
  }

  const notes: string[] = [];
  const platforms = options.platforms ?? ["ios", "android"];
  const project: Project = {
    root,
    ...(typeof pkg.name === "string" ? { name: pkg.name } : {}),
    reactNative: readJson(join(rnDir, "package.json")).version,
    declared,
    libraries: readLibraries(root, declared),
    notes,
  };

  if (platforms.includes("ios")) {
    if (isDir(join(root, "ios"))) project.ios = readIos(join(root, "ios"), options, notes);
    else notes.push("No ios/ folder; iOS checks are skipped.");
  }
  if (platforms.includes("android")) {
    if (isDir(join(root, "android"))) project.android = readAndroid(join(root, "android"), options, notes);
    else notes.push("No android/ folder; Android checks are skipped.");
  }
  if (["react-native.config.js", "react-native.config.ts"].some((file) => existsSync(join(root, file)))) {
    notes.push("react-native.config.js may turn autolinking off for some libraries; rn-preflight doesn't run it, so it treats every native dependency as linked.");
  }
  return project;
}
