import { infoKeyLocation } from "./helpers.js";
import type { RawFinding, Rule } from "./types.js";

const CHECKED = "2026-11-04";
const DOTTED = /^\d+(\.\d+){0,2}$/;
const MAX_VERSION_CODE = 2_100_000_000;

/** Compares dotted version numbers: 1.10 > 1.9, 1.0 == 1. */
export function compareDotted(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export const versionFormat: Rule = {
  id: "version-format",
  platform: "both",
  severity: "error",
  title: "Version numbers are in the form the stores accept",
  why: "App Store Connect needs CFBundleShortVersionString and CFBundleVersion as up to three period-separated integers. Google Play needs versionCode to be a whole number from 1 to 2,100,000,000.",
  docs: ["https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring", "https://developer.android.com/studio/publish/versioning"],
  checkedOn: CHECKED,
  check(project) {
    const findings: RawFinding[] = [];
    const ios = project.ios;
    if (ios) {
      for (const [key, value, setting] of [["CFBundleShortVersionString", ios.version.marketing, "MARKETING_VERSION"], ["CFBundleVersion", ios.version.build, "CURRENT_PROJECT_VERSION"]] as const) {
        if (value === undefined) {
          findings.push({ key: `ios:${key}`, message: `${key} isn't set (neither in Info.plist nor ${setting})`, ...(ios.infoPlist ? { file: ios.infoPlist.file } : {}) });
        } else if (!DOTTED.test(value)) {
          findings.push({ key: `ios:${key}`, message: `${key} is "${value}"; App Store Connect accepts only up to three period-separated integers`, ...infoKeyLocation(ios, key), fix: 'Use a value like "1.4.2" (and keep labels like "beta" out of it).' });
        }
      }
    }
    const code = project.android?.versionCode;
    if (code?.value !== undefined) {
      const n = Number(code.value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_VERSION_CODE) {
        findings.push({ key: "android:versionCode", message: `versionCode is ${code.value}; Google Play needs a whole number from 1 to 2100000000`, file: code.file, line: code.line });
      }
    }
    return findings;
  },
};

export const versionsMatch: Rule = {
  id: "versions-match",
  platform: "both",
  severity: "warning",
  title: "iOS and Android show the same version",
  why: "Users and support see the version in both stores; a mismatch is usually a forgotten bump on one side.",
  docs: [],
  checkedOn: CHECKED,
  check(project) {
    const marketing = project.ios?.version.marketing;
    const name = project.android?.versionName;
    if (!marketing || !name?.value || marketing === name.value) return [];
    return [{ key: "mismatch", message: `iOS is ${marketing} but Android is ${name.value}`, file: name.file, line: name.line, fix: "Bump both in the same change (MARKETING_VERSION in Xcode, versionName in android/app/build.gradle)." }];
  },
};

export const versionBump: Rule = {
  id: "version-bump",
  platform: "both",
  severity: "warning",
  title: "Build numbers went up since the last release",
  why: "App Store Connect rejects a build number already uploaded for the same version, and Google Play rejects a versionCode it has seen. rn-preflight compares with the latest git tag, or --since.",
  docs: ["https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion", "https://developer.android.com/studio/publish/versioning"],
  checkedOn: CHECKED,
  check(project) {
    const previous = project.previous;
    if (!previous) return [];
    if (!previous.ref) return previous.note ? [{ key: "no-ref", severity: "info", message: `Version bumps not checked: ${previous.note}` }] : [];
    const findings: RawFinding[] = [];
    const ios = project.ios;
    const before = previous.ios;
    if (ios && before?.marketing && ios.version.marketing && DOTTED.test(before.marketing) && DOTTED.test(ios.version.marketing)) {
      const versionChange = compareDotted(ios.version.marketing, before.marketing);
      const where = ios.infoPlist ? { file: ios.infoPlist.file } : {};
      if (versionChange < 0) {
        findings.push({ key: "ios:version-lower", message: `iOS version ${ios.version.marketing} is lower than ${before.marketing} at ${previous.ref}`, ...where });
      } else if (versionChange === 0 && before.build && ios.version.build && DOTTED.test(before.build) && DOTTED.test(ios.version.build) && compareDotted(ios.version.build, before.build) <= 0) {
        findings.push({ key: "ios:build", message: `iOS build ${ios.version.build} of ${ios.version.marketing} isn't higher than ${before.build} at ${previous.ref}`, ...where, fix: "Raise CURRENT_PROJECT_VERSION (Xcode: Build) before archiving." });
      }
    }
    const code = project.android?.versionCode;
    const old = previous.android?.versionCode;
    if (code?.value && old && Number(code.value) <= Number(old)) {
      findings.push({ key: "android:versionCode", message: `versionCode ${code.value} isn't higher than ${old} at ${previous.ref}`, file: code.file, line: code.line, fix: "Raise versionCode in android/app/build.gradle." });
    }
    return findings;
  },
};
