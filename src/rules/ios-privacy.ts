import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import privacy from "../data/privacy-manifest.json" with { type: "json" };
import { findFiles, isDir, lineOf, readText } from "../core/fs.js";
import type { IosProject, Project } from "../core/types.js";
import { isDict, parsePlist, type PlistDict } from "../readers/plist.js";
import { list } from "./helpers.js";
import type { RawFinding, Rule, RuleData } from "./types.js";

const DATA = privacy as RuleData<{
  reasons: Record<string, string[]>;
  reactNativeCore: Record<string, string>;
  listedSdkPods: Record<string, string[]>;
  notChecked: string;
}>;

const DOCS_MANIFEST = "https://developer.apple.com/documentation/bundleresources/privacy-manifest-files";
const DOCS_REASONS = "https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api";
const DOCS_SDKS = "https://developer.apple.com/support/third-party-SDK-requirements/";

const short = (category: string) => category.replace("NSPrivacyAccessedAPICategory", "");

/** The app's own manifest: the one next to Info.plist when there are several. */
export function appManifest(ios: IosProject) {
  const near = ios.infoPlist && ios.privacyManifests.find((m) => dirname(m.file) === dirname(ios.infoPlist!.file));
  return near ?? ios.privacyManifests[0];
}

/** Declared required-reason API categories and their reasons. */
export function declaredApis(manifest: PlistDict | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const types = manifest?.NSPrivacyAccessedAPITypes;
  if (!Array.isArray(types)) return out;
  for (const entry of types) {
    if (!isDict(entry) || typeof entry.NSPrivacyAccessedAPIType !== "string") continue;
    const reasons = Array.isArray(entry.NSPrivacyAccessedAPITypeReasons) ? entry.NSPrivacyAccessedAPITypeReasons.filter((r): r is string => typeof r === "string") : [];
    out.set(entry.NSPrivacyAccessedAPIType, [...(out.get(entry.NSPrivacyAccessedAPIType) ?? []), ...reasons]);
  }
  return out;
}

export const privacyManifestPresent: Rule = {
  id: "ios-privacy-manifest",
  platform: "ios",
  severity: "error",
  title: "The app ships a privacy manifest that covers React Native's own API use",
  why: "React Native uses required-reason APIs (file timestamps, user defaults, boot time). Without them declared in the app's PrivacyInfo.xcprivacy, App Store Connect sends ITMS-91053.",
  docs: [DOCS_MANIFEST, DOCS_REASONS],
  checkedOn: DATA.checkedOn,
  check(project) {
    const ios = project.ios!;
    const manifest = appManifest(ios);
    if (!manifest) {
      return [{ key: "missing", message: "The app has no PrivacyInfo.xcprivacy", fix: "Run pod install (React Native creates one), then add the file to the app target in Xcode." }];
    }
    if (manifest.error) return [{ key: "unreadable", message: `PrivacyInfo.xcprivacy can't be read: ${manifest.error}`, file: manifest.file }];
    const findings: RawFinding[] = [];
    if (!ios.privacyManifestInTarget) {
      findings.push(
        ios.pods
          ? { key: "not-in-target", message: `PrivacyInfo.xcprivacy isn't in ${ios.target}'s Copy Bundle Resources, so it won't ship`, file: manifest.file, fix: "In Xcode, tick the app target under Target Membership for PrivacyInfo.xcprivacy." }
          : { key: "not-in-target", severity: "info", message: `PrivacyInfo.xcprivacy isn't in ${ios.target}'s resources yet; pod install adds it`, file: manifest.file, fix: "Run pod install in ios/." },
      );
    }
    const declared = declaredApis(manifest.values);
    const missing = Object.keys(DATA.data.reactNativeCore).filter((category) => !declared.has(category));
    if (missing.length) {
      findings.push({
        key: "core-apis",
        message: `PrivacyInfo.xcprivacy doesn't declare ${list(missing.map(short))}, which React Native itself uses`,
        file: manifest.file,
        fix: `Run pod install (it merges these in), or add them with reasons ${list(missing.map((c) => DATA.data.reactNativeCore[c]!))}.`,
      });
    }
    return findings;
  },
};

export const privacyReasons: Rule = {
  id: "ios-privacy-reasons",
  platform: "ios",
  severity: "error",
  title: "Required-reason API entries use Apple's categories and reason codes",
  why: "A misspelled category or a reason code Apple doesn't list doesn't count as a declaration, so the upload still gets ITMS-91053.",
  docs: [DOCS_REASONS],
  checkedOn: DATA.checkedOn,
  check(project) {
    const manifest = appManifest(project.ios!);
    if (!manifest?.values) return [];
    const findings: RawFinding[] = [];
    for (const [category, reasons] of declaredApis(manifest.values)) {
      const valid = DATA.data.reasons[category];
      const line = lineOf(manifest.file, category);
      if (!valid) {
        findings.push({ key: category, message: `${category} isn't a required-reason API category`, file: manifest.file, line, fix: `Use one of ${list(Object.keys(DATA.data.reasons).map(short))}.` });
        continue;
      }
      if (!reasons.length) findings.push({ key: `${category}:none`, message: `${short(category)} is declared with no reason`, file: manifest.file, line, fix: `Add a reason: ${valid.join(", ")}.` });
      for (const reason of reasons.filter((r) => !valid.includes(r))) {
        findings.push({ key: `${category}:${reason}`, message: `${reason} isn't a reason Apple accepts for ${short(category)}`, file: manifest.file, line: lineOf(manifest.file, reason) ?? line, fix: `Valid reasons: ${valid.join(", ")}.` });
      }
    }
    const values = manifest.values;
    const domains = values.NSPrivacyTrackingDomains;
    if (values.NSPrivacyTracking === true && !(Array.isArray(domains) && domains.length)) {
      findings.push({ key: "tracking-domains", severity: "warning", message: "NSPrivacyTracking is true but NSPrivacyTrackingDomains is empty", file: manifest.file, line: lineOf(manifest.file, "NSPrivacyTracking"), fix: "List the domains used for tracking, or set NSPrivacyTracking to false if the app doesn't track." });
    }
    return findings;
  },
};

/** Every PrivacyInfo.xcprivacy a pod brings: in ios/Pods for downloaded pods, in node_modules for local ones. */
function podManifests(project: Project): { owner: string; file: string }[] {
  const ios = project.ios!;
  const out: { owner: string; file: string }[] = [];
  for (const library of project.libraries.filter((l) => l.ios)) for (const file of library.privacyManifests) out.push({ owner: library.name, file });
  if (ios.podsDir) {
    for (const pod of readdirSync(ios.podsDir)) {
      if (isDir(join(ios.podsDir, pod)) && !["Headers", "Local Podspecs", "Target Support Files", "Pods.xcodeproj"].includes(pod)) {
        for (const file of findFiles(join(ios.podsDir, pod), (name) => name === "PrivacyInfo.xcprivacy", 8)) out.push({ owner: pod, file });
      }
    }
  }
  return out;
}

export const privacyPodApis: Rule = {
  id: "ios-privacy-pod-apis",
  platform: "ios",
  severity: "warning",
  title: "The app's privacy manifest includes the API use its pods declare",
  why: "Pods are linked statically, so React Native's pod install copies their required-reason APIs into the app's manifest. When that step is off or the file was edited since, Apple can send ITMS-91053.",
  docs: [DOCS_REASONS],
  checkedOn: DATA.checkedOn,
  check(project) {
    const manifest = appManifest(project.ios!);
    if (!manifest?.values) return [];
    const declared = declaredApis(manifest.values);
    const missing = new Map<string, Set<string>>();
    for (const { owner, file } of podManifests(project)) {
      let values;
      try {
        values = parsePlist(readText(file));
      } catch {
        continue;
      }
      for (const category of declaredApis(isDict(values) ? values : undefined).keys()) {
        if (!declared.has(category) && DATA.data.reasons[category]) missing.set(category, (missing.get(category) ?? new Set()).add(owner));
      }
    }
    return [...missing].map(([category, owners]) => ({
      key: category,
      message: `${list([...owners].sort())} declare${owners.size === 1 ? "s" : ""} ${short(category)}, but the app's PrivacyInfo.xcprivacy doesn't`,
      file: manifest.file,
      fix: "Run pod install with privacy_file_aggregation_enabled left on (the default), or add the category and the pod's reason by hand.",
    }));
  },
};

export const privacySdkList: Rule = {
  id: "ios-privacy-sdk-list",
  platform: "ios",
  severity: "error",
  title: "SDKs on Apple's list ship their own privacy manifest",
  why: "Apple requires a privacy manifest (and a signature, for binary SDKs) in each SDK on its commonly used SDK list; uploads without one get ITMS-91061. " + DATA.data.notChecked,
  docs: [DOCS_SDKS],
  checkedOn: DATA.checkedOn,
  check(project) {
    const ios = project.ios!;
    if (!ios.pods || !ios.podsDir) return [];
    const findings: RawFinding[] = [];
    for (const [sdk, pods] of Object.entries(DATA.data.listedSdkPods)) {
      for (const pod of pods) {
        const version = ios.pods[pod];
        const dir = join(ios.podsDir, pod);
        if (!version || !isDir(dir)) continue;
        const where = relative(project.root, dir);
        if (!findFiles(dir, (name) => name === "PrivacyInfo.xcprivacy", 8).length) {
          findings.push({ key: pod, message: `${pod} ${version} (${sdk} on Apple's list) has no privacy manifest`, file: join(ios.dir, "Podfile.lock"), line: lineOf(join(ios.dir, "Podfile.lock"), `- ${pod} (`), fix: `Update ${pod} (or the React Native library that brings it in) to a version that ships PrivacyInfo.xcprivacy; checked ${where}.` });
        }
        for (const framework of findFiles(dir, (name) => name.endsWith(".xcframework"), 4)) {
          if (!isDir(join(framework, "_CodeSignature"))) {
            findings.push({ key: `${pod}:signature`, severity: "warning", message: `${relative(dir, framework)} in ${pod} isn't signed; Apple asks for signatures on binary SDKs from its list`, file: framework, fix: `Update ${pod} to a signed release.` });
          }
        }
      }
    }
    return findings;
  },
};
