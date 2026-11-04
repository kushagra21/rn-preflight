import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { UserError } from "../core/errors.js";
import { isDir, readIfExists, readText } from "../core/fs.js";
import type { AndroidManifestFile, AndroidProject, GradleValue } from "../core/types.js";
import { assignments, childBlock, childBlocks, lineAt, readExt, readLocals, readProperties, resolve, stripComments, type Block, type Scope } from "./gradle.js";

export interface AndroidOptions {
  module?: string;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, isArray: (_name, _path, _leaf, isAttribute) => !isAttribute });

const attrs = (node: Record<string, any>): Record<string, string> =>
  Object.fromEntries(Object.entries(node).filter(([, v]) => typeof v === "string")) as Record<string, string>;

export function readManifest(file: string, sourceSet: string): AndroidManifestFile {
  const base: AndroidManifestFile = { file, sourceSet, permissions: [], application: {} };
  try {
    const manifest = xml.parse(readText(file)).manifest?.[0];
    if (!manifest) return { ...base, error: "no <manifest> element" };
    const permissions = [...(manifest["uses-permission"] ?? []), ...(manifest["uses-permission-sdk-23"] ?? [])]
      .map(attrs)
      .filter((p) => p["android:name"])
      .map((p) => ({
        name: p["android:name"]!,
        ...(p["android:maxSdkVersion"] ? { maxSdkVersion: p["android:maxSdkVersion"] } : {}),
        removed: p["tools:node"] === "remove",
      }));
    const application = manifest.application?.[0];
    return {
      ...base,
      ...(manifest.package ? { package: manifest.package as string } : {}),
      permissions,
      application: application ? attrs(application) : {},
    };
  } catch (error) {
    return { ...base, error: (error as Error).message };
  }
}

/** settings.gradle names the app module; the app module is the one applying com.android.application. */
function pickModule(dir: string, wanted: string | undefined): string {
  if (wanted) {
    if (!isDir(join(dir, wanted))) throw new UserError(`No module folder ${wanted} in ${dir}.`);
    return join(dir, wanted);
  }
  if (isDir(join(dir, "app"))) return join(dir, "app");
  const appModule = readdirSync(dir).find((name) => {
    const build = readIfExists(join(dir, name, "build.gradle")) ?? readIfExists(join(dir, name, "build.gradle.kts"));
    return build && /com\.android\.application/.test(build);
  });
  if (!appModule) throw new UserError(`No app module in ${dir}; pick one with --android-module.`);
  return join(dir, appModule);
}

const ALIASES: Record<string, string> = {
  targetSdk: "targetSdk",
  targetSdkVersion: "targetSdk",
  minSdk: "minSdk",
  minSdkVersion: "minSdk",
  compileSdk: "compileSdk",
  compileSdkVersion: "compileSdk",
  versionCode: "versionCode",
  versionName: "versionName",
  applicationId: "applicationId",
  namespace: "namespace",
  minifyEnabled: "minifyEnabled",
  isMinifyEnabled: "minifyEnabled",
  debuggable: "debuggable",
  isDebuggable: "debuggable",
  signingConfig: "signingConfig",
  storeFile: "storeFile",
};

export function readAndroid(androidDir: string, options: AndroidOptions, notes: string[]): AndroidProject {
  const appDir = pickModule(androidDir, options.module);
  const buildFile = [join(appDir, "build.gradle"), join(appDir, "build.gradle.kts")].find(existsSync);
  if (!buildFile) throw new UserError(`No build.gradle in ${appDir}.`);
  const source = readText(buildFile);
  const clean = stripComments(source);

  const rootBuild = readIfExists(join(androidDir, "build.gradle")) ?? readIfExists(join(androidDir, "build.gradle.kts")) ?? "";
  const gradleProperties = readProperties(readIfExists(join(androidDir, "gradle.properties")) ?? "");
  const scope: Scope = { ext: { ...readExt(rootBuild), ...readExt(source) }, properties: gradleProperties, locals: readLocals(source) };

  const value = (raw: string, offset: number): GradleValue => {
    const resolved = resolve(raw, scope);
    return { raw, ...(resolved !== undefined ? { value: resolved } : {}), file: buildFile, line: lineAt(source, offset) };
  };
  const settings = (block: Block | undefined) => {
    const out: Record<string, GradleValue> = {};
    if (block) for (const [key, raw, offset] of assignments(block)) if (ALIASES[key]) out[ALIASES[key]!] = value(raw, offset);
    return out;
  };

  const android = childBlock({ start: 0, body: clean }, "android");
  if (!android) notes.push(`${buildFile} has no android { } block.`);
  const top = settings(android);
  const defaults = settings(childBlock(android, "defaultConfig"));

  const signingConfigs: AndroidProject["signingConfigs"] = {};
  for (const [name, block] of childBlocks(childBlock(android, "signingConfigs") ?? { start: 0, body: "" })) {
    const s = settings(block);
    signingConfigs[name] = { ...(s.storeFile ? { storeFile: s.storeFile } : {}), line: lineAt(source, block.start) };
  }
  const buildTypes: AndroidProject["buildTypes"] = {};
  for (const [name, block] of childBlocks(childBlock(android, "buildTypes") ?? { start: 0, body: "" })) {
    const s = settings(block);
    buildTypes[name] = {
      ...(s.signingConfig ? { signingConfig: s.signingConfig } : {}),
      ...(s.minifyEnabled ? { minifyEnabled: s.minifyEnabled } : {}),
      ...(s.debuggable ? { debuggable: s.debuggable } : {}),
      line: lineAt(source, block.start),
    };
  }
  if (childBlock(android, "productFlavors")) notes.push("The app has product flavors; rn-preflight reads defaultConfig only, so flavor overrides aren't checked.");

  const manifests: AndroidManifestFile[] = [];
  const srcDir = join(appDir, "src");
  if (isDir(srcDir)) {
    for (const set of readdirSync(srcDir).sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)))) {
      const file = join(srcDir, set, "AndroidManifest.xml");
      if (existsSync(file)) manifests.push(readManifest(file, set));
    }
  }
  if (!manifests.some((m) => m.sourceSet === "main")) notes.push(`No ${join(srcDir, "main", "AndroidManifest.xml")}.`);

  const pick = (key: string) => defaults[key] ?? top[key];
  const project: AndroidProject = { dir: androidDir, appDir, buildFile, signingConfigs, buildTypes, gradleProperties, manifests };
  for (const key of ["applicationId", "versionCode", "versionName", "minSdk", "targetSdk"] as const) {
    const v = pick(key);
    if (v) project[key] = v;
  }
  if (top.namespace) project.namespace = top.namespace;
  if (top.compileSdk) project.compileSdk = top.compileSdk;
  for (const key of ["versionCode", "versionName", "targetSdk"] as const) {
    const v = project[key];
    if (!v) notes.push(`${buildFile} sets no ${key} in defaultConfig.`);
    else if (v.value === undefined) notes.push(`${key} in ${buildFile}:${v.line} is computed (${v.raw}); rn-preflight can't resolve it, so checks on it are skipped.`);
  }
  return project;
}
