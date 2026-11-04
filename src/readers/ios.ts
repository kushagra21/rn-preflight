import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { UserError } from "../core/errors.js";
import { findFiles, isDir, readIfExists, readJson, readText } from "../core/fs.js";
import type { AppIconImage, IosProject } from "../core/types.js";
import { expandSettings, readPbxProject, type PbxTarget, type PbxValue } from "./pbxproj.js";
import { isDict, parsePlist, type PlistDict, type PlistValue } from "./plist.js";
import { parseStrings } from "./strings.js";

export interface IosOptions {
  xcodeproj?: string;
  target?: string;
  configuration?: string;
}

const APP_PRODUCT = "com.apple.product-type.application";

function pickXcodeproj(dir: string, wanted: string | undefined): string {
  if (wanted) {
    const path = isAbsolute(wanted) ? wanted : join(dir, wanted);
    if (!isDir(path)) throw new UserError(`${wanted} doesn't exist in ${dir}.`);
    return path;
  }
  const found = readdirSync(dir).filter((name) => name.endsWith(".xcodeproj") && name !== "Pods.xcodeproj");
  if (found.length === 0) throw new UserError(`No .xcodeproj in ${dir}.`);
  if (found.length > 1) throw new UserError(`Several Xcode projects in ${dir} (${found.join(", ")}); pick one with --xcodeproj.`);
  return join(dir, found[0]!);
}

function pickTarget(targets: PbxTarget[], projectName: string, wanted: string | undefined, notes: string[]): PbxTarget {
  const apps = targets.filter((t) => t.productType === APP_PRODUCT);
  if (wanted) {
    const target = targets.find((t) => t.name === wanted);
    if (!target) throw new UserError(`No target named ${wanted}. App targets: ${apps.map((t) => t.name).join(", ") || "none"}.`);
    return target;
  }
  if (apps.length === 0) throw new UserError("The Xcode project has no app target.");
  const sameName = apps.find((t) => t.name === projectName);
  if (apps.length > 1) {
    const chosen = sameName ?? apps[0]!;
    notes.push(`Several app targets (${apps.map((t) => t.name).join(", ")}); checked ${chosen.name}. Pick another with --target.`);
    return chosen;
  }
  return apps[0]!;
}

const flatten = (value: PbxValue): string =>
  Array.isArray(value) ? value.map(flatten).join(" ") : typeof value === "string" ? value : "";

/** Build settings for one target and configuration, the way Xcode layers them (xcconfig files aside). */
function buildSettingsFor(project: ReturnType<typeof readPbxProject>, target: PbxTarget, configuration: string, iosDir: string, projectName: string) {
  const raw: Record<string, string> = {
    SRCROOT: iosDir,
    PROJECT_DIR: iosDir,
    PROJECT_NAME: projectName,
    TARGET_NAME: target.name,
    CONFIGURATION: configuration,
    PRODUCT_NAME: target.name,
    EFFECTIVE_PLATFORM_NAME: "-iphoneos",
  };
  for (const [key, value] of Object.entries(project.configurations[configuration] ?? {})) raw[key] = flatten(value);
  for (const [key, value] of Object.entries(target.configurations[configuration] ?? {})) raw[key] = flatten(value);
  raw.PRODUCT_MODULE_NAME ??= raw.PRODUCT_NAME!.replace(/[^A-Za-z0-9_]/g, "_");

  // Settings can refer to each other; a few passes settle any realistic chain.
  const settings = { ...raw };
  for (let pass = 0; pass < 4; pass++) {
    for (const key of Object.keys(settings)) settings[key] = expandSettings(settings[key]!, settings).replace(/\$\(inherited\)\s*/g, "").trim();
  }
  return settings;
}

const expandPlist = (value: PlistValue, settings: Record<string, string>): PlistValue => {
  if (typeof value === "string") return expandSettings(value, settings);
  if (Array.isArray(value)) return value.map((v) => expandPlist(v, settings));
  if (isDict(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandPlist(v, settings)]));
  return value;
};

/** Whether `file` is in one of the target's Xcode 16 synchronized folders and not excluded from it. */
function inSyncedFolder(iosDir: string, target: PbxTarget, file: string): boolean {
  return target.syncedFolders.some(({ path, exceptions }) => {
    const inside = relative(join(iosDir, path), file);
    return !inside.startsWith("..") && !isAbsolute(inside) && !exceptions.includes(inside);
  });
}

const relativeToIos = (iosDir: string, path: string) => (isAbsolute(path) ? path : join(iosDir, path));

function readPlistFile(file: string, notes: string[]): PlistDict | undefined {
  try {
    const value = parsePlist(readText(file));
    if (isDict(value)) return value;
    notes.push(`${file} isn't a dictionary plist.`);
  } catch (error) {
    notes.push(`Couldn't read ${file}: ${(error as Error).message}`);
  }
  return undefined;
}

/** Pods in Podfile.lock's PODS section, with subspecs folded into their pod. */
export function readPodfileLock(text: string): Record<string, string> {
  const pods: Record<string, string> = {};
  let inPods = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) inPods = line.startsWith("PODS:");
    if (!inPods) continue;
    const match = /^ {2}- "?([^\s"(]+) \(([^)]+)\)/.exec(line);
    if (match) pods[match[1]!.split("/")[0]!] ??= match[2]!;
  }
  return pods;
}

function readAppIcon(iosDir: string, name: string): IosProject["appIcon"] {
  // Xcode 26's Icon Composer files (Name.icon) replace the asset catalog set.
  const composer = findFiles(iosDir, (file) => file === `${name}.icon`)[0];
  const dir = findFiles(iosDir, (file) => file === `${name}.appiconset`)[0];
  const contents = dir && join(dir, "Contents.json");
  const images = contents && existsSync(contents) ? ((readJson(contents).images ?? []) as AppIconImage[]) : [];
  return { name, ...(dir ? { dir } : {}), ...(composer ? { composerFile: composer } : {}), images };
}

/** Permission handlers named in react-native-permissions' setup_permissions([...]) in the Podfile. */
export function readPodfilePermissions(podfile: string): string[] | undefined {
  const call = /^[ \t]*setup_permissions\s*\(?\s*\[([\s\S]*?)\]/m.exec(podfile);
  if (!call) return undefined;
  const live = call[1]!.split("\n").map((line) => line.replace(/#.*$/, ""));
  return [...live.join("\n").matchAll(/["']([A-Za-z]+)["']/g)].map((m) => m[1]!);
}

/** InfoPlist.strings in each .lproj folder next to Info.plist: the translated purpose strings. */
function readInfoPlistStrings(infoPlistFile: string, notes: string[]): IosProject["infoPlistStrings"] {
  const out: NonNullable<IosProject["infoPlistStrings"]> = [];
  for (const file of findFiles(dirname(infoPlistFile), (name) => name === "InfoPlist.strings", 2)) {
    const language = basename(dirname(file), ".lproj");
    try {
      out.push({ language, file, values: parseStrings(readFileSync(file)) });
    } catch (error) {
      notes.push(`Couldn't read ${file}: ${(error as Error).message}`);
    }
  }
  return out;
}

export function readIos(iosDir: string, options: IosOptions, notes: string[]): IosProject {
  const xcodeproj = pickXcodeproj(iosDir, options.xcodeproj);
  const projectName = basename(xcodeproj, ".xcodeproj");
  const pbxFile = join(xcodeproj, "project.pbxproj");
  if (!existsSync(pbxFile)) throw new UserError(`${pbxFile} is missing.`);

  let project;
  try {
    project = readPbxProject(readText(pbxFile));
  } catch (error) {
    throw new UserError(`Couldn't read ${pbxFile}: ${(error as Error).message}`);
  }
  const target = pickTarget(project.targets, projectName, options.target, notes);
  const configuration = options.configuration ?? "Release";
  if (!target.configurations[configuration]) {
    throw new UserError(`Target ${target.name} has no ${configuration} configuration (has ${Object.keys(target.configurations).join(", ")}). Pick one with --configuration.`);
  }
  const settings = buildSettingsFor(project, target, configuration, iosDir, projectName);

  const ios: IosProject = {
    dir: iosDir,
    xcodeproj,
    target: target.name,
    configuration,
    buildSettings: settings,
    version: {},
    privacyManifests: [],
    privacyManifestInTarget: target.resources.includes("PrivacyInfo.xcprivacy"),
  };

  const keysFromBuildSettings = Object.keys(settings)
    .filter((key) => key.startsWith("INFOPLIST_KEY_"))
    .map((key) => key.slice("INFOPLIST_KEY_".length));
  const fromSettings: PlistDict = Object.fromEntries(keysFromBuildSettings.map((key) => [key, settings[`INFOPLIST_KEY_${key}`]!]));
  if (settings.INFOPLIST_FILE) {
    const file = relativeToIos(iosDir, settings.INFOPLIST_FILE);
    const values = existsSync(file) ? readPlistFile(file, notes) : (notes.push(`INFOPLIST_FILE points at ${file}, which doesn't exist.`), undefined);
    if (values) {
      ios.infoPlist = { file, values: { ...fromSettings, ...(expandPlist(values, settings) as PlistDict) }, keysFromBuildSettings };
      ios.infoPlistStrings = readInfoPlistStrings(file, notes);
    }
  } else if (keysFromBuildSettings.length) {
    ios.infoPlist = { file: pbxFile, values: fromSettings, keysFromBuildSettings };
  } else {
    notes.push(`Target ${target.name} sets no INFOPLIST_FILE.`);
  }

  const info = ios.infoPlist?.values ?? {};
  const str = (value: PlistValue | undefined) => (typeof value === "string" && value && !value.includes("$(") ? value : undefined);
  ios.version = {
    marketing: str(info.CFBundleShortVersionString) ?? settings.MARKETING_VERSION,
    build: str(info.CFBundleVersion) ?? settings.CURRENT_PROJECT_VERSION,
  };

  for (const file of findFiles(iosDir, (name) => name === "PrivacyInfo.xcprivacy")) {
    const fileNotes: string[] = [];
    const values = readPlistFile(file, fileNotes);
    // When paths resolve, match the exact file; a project whose paths don't resolve falls back to the name.
    const byPath = target.resourcePaths.some((path) => join(isAbsolute(path) ? "" : iosDir, path) === file);
    const byName = target.resourcePaths.length === 0 && target.resources.includes("PrivacyInfo.xcprivacy");
    const inTarget = byPath || byName || inSyncedFolder(iosDir, target, file);
    ios.privacyManifests.push({ file, inTarget, ...(values ? { values } : { error: fileNotes[0] }) });
    if (inTarget) ios.privacyManifestInTarget = true;
  }

  if (settings.CODE_SIGN_ENTITLEMENTS) {
    const file = relativeToIos(iosDir, settings.CODE_SIGN_ENTITLEMENTS);
    const values = existsSync(file) ? readPlistFile(file, notes) : (notes.push(`CODE_SIGN_ENTITLEMENTS points at ${file}, which doesn't exist.`), undefined);
    if (values) ios.entitlements = { file, values };
  }

  ios.appIcon = readAppIcon(iosDir, settings.ASSETCATALOG_COMPILER_APPICON_NAME || "AppIcon");

  const storyboard = str(info.UILaunchStoryboardName);
  if (storyboard) {
    const file = findFiles(iosDir, (name) => name === `${storyboard}.storyboard` || name === `${storyboard}.xib`)[0];
    ios.launchStoryboard = { name: storyboard, ...(file ? { file } : {}) };
  }

  const podfile = readIfExists(join(iosDir, "Podfile"));
  const handlers = podfile === undefined ? undefined : readPodfilePermissions(podfile);
  if (handlers) ios.podfilePermissions = handlers;
  if (isDir(join(iosDir, "Pods"))) ios.podsDir = join(iosDir, "Pods");

  const lock = readIfExists(join(iosDir, "Podfile.lock"));
  if (lock !== undefined) ios.pods = readPodfileLock(lock);
  else if (existsSync(join(iosDir, "Podfile"))) notes.push("ios/Podfile.lock is missing; run pod install so native SDK versions can be checked.");

  return ios;
}
