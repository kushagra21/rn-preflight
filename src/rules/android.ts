import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import permissionData from "../data/android-permissions.json" with { type: "json" };
import targetSdkData from "../data/android-target-sdk.json" with { type: "json" };
import templateIcons from "../data/rn-template-icons.json" with { type: "json" };
import { isDir, lineOf } from "../core/fs.js";
import type { AndroidProject } from "../core/types.js";
import { releasePermissions } from "../readers/android.js";
import { list } from "./helpers.js";
import type { RawFinding, Rule, RuleData } from "./types.js";

/** Today, as YYYY-MM-DD; tests replace it. */
export const clock = { today: () => new Date().toISOString().slice(0, 10) };

type Deadline = { from: string; newApps: number; updates: number };
const TARGET = targetSdkData as RuleData<{ phone: Deadline[] }>;

export const targetSdk: Rule = {
  id: "android-target-sdk",
  platform: "android",
  severity: "error",
  title: "targetSdk meets Google Play's current requirement",
  why: "Google Play rejects new apps and updates whose targetSdk is below the yearly requirement (phones and tablets; Wear OS, TV and Automotive differ).",
  docs: TARGET.sources,
  checkedOn: TARGET.checkedOn,
  check(project) {
    const android = project.android!;
    const value = Number(android.targetSdk?.value);
    if (!android.targetSdk || !Number.isInteger(value)) return [];
    const today = clock.today();
    const deadlines = [...TARGET.data.phone].sort((a, b) => a.from.localeCompare(b.from));
    const current = deadlines.filter((d) => d.from <= today).pop();
    const next = deadlines.find((d) => d.from > today);
    const where = { file: android.targetSdk.file, line: android.targetSdk.line };
    if (current && value < current.updates) {
      return [{ key: "below", message: `targetSdk is ${value}; Google Play has required ${current.updates} for new apps and updates since ${current.from}`, ...where, fix: `Raise targetSdkVersion to ${current.updates} and test the behaviour changes of each Android version in between.` }];
    }
    if (next && value < next.updates) {
      return [{ key: "upcoming", severity: "info", message: `targetSdk is ${value}; Google Play requires ${next.updates} from ${next.from}`, ...where }];
    }
    return [];
  },
};

type Declaration = { policy: string; permissions?: string[]; prefix?: string; note: string };
const PERMISSIONS = permissionData as RuleData<{ declarations: Declaration[] }>;

const shortName = (name: string) => name.replace(/^android\.permission\./, "");

export const sensitivePermissions: Rule = {
  id: "android-sensitive-permissions",
  platform: "android",
  severity: "warning",
  title: "Permissions that need a Play Console declaration are known and wanted",
  why: "Google Play restricts some permissions to apps whose core feature needs them. The app must declare and justify each one on the App content page, or the release is rejected. They often come from a library, not the app.",
  docs: PERMISSIONS.sources,
  checkedOn: PERMISSIONS.checkedOn,
  check(project) {
    const android = project.android!;
    const findings: RawFinding[] = [];
    for (const permission of releasePermissions(project)) {
      const name = shortName(permission.name);
      const declaration = PERMISSIONS.data.declarations.find((d) => d.permissions?.includes(name) || (d.prefix && name.startsWith(d.prefix)));
      if (!declaration) continue;
      // An old-storage style limit below Android 13 means newer devices never see it.
      if (permission.maxSdkVersion && Number(permission.maxSdkVersion) < 33 && declaration.policy === "Photo and Video") continue;
      const fromApp = permission.sources.includes("app");
      const libraries = permission.sources.filter((s) => s !== "app");
      const by = [...(fromApp ? ["the app's manifest"] : []), ...libraries];
      const main = android.manifests.find((m) => m.sourceSet === "main");
      findings.push({
        key: permission.name,
        message: `${name} (${declaration.policy} policy) comes from ${list(by)}; Play ${declaration.note}`,
        ...(fromApp && main ? { file: main.file, line: lineOf(main.file, permission.name) } : {}),
        fix: fromApp
          ? "Declare it in Play Console (App content → Sensitive permissions), or remove it if the app can do without."
          : `If the app doesn't need it, add <uses-permission android:name="${permission.name}" tools:node="remove"/> to AndroidManifest.xml; otherwise declare it in Play Console.`,
      });
    }
    return findings;
  },
};

const DEBUG_SIGNING = /signingConfigs\.(debug\b|getByName\(\s*["']debug["']\s*\))/;

export const releaseSigning: Rule = {
  id: "android-release-signing",
  platform: "android",
  severity: "warning",
  title: "The release build isn't signed with the debug key",
  why: "Google Play rejects bundles signed in debug mode. The React Native template signs release builds with debug.keystore; that's fine only if the real upload key is injected when you build (Android Studio's Generate Signed Bundle, or CI).",
  docs: ["https://reactnative.dev/docs/signed-apk-android", "https://developer.android.com/studio/publish/app-signing"],
  checkedOn: "2026-11-04",
  check(project) {
    const android = project.android!;
    const release = android.buildTypes.release;
    if (!release?.signingConfig) {
      return [{ key: "unsigned", severity: "info", message: "buildTypes.release sets no signingConfig, so Gradle builds an unsigned bundle", file: android.buildFile, ...(release?.line ? { line: release.line } : {}), fix: "Sign it with your upload key when building (CI or Android Studio), or add a release signingConfig that reads the key from gradle.properties." }];
    }
    const config = release.signingConfig;
    const name = /signingConfigs\.(?:getByName\(\s*["'])?(\w+)/.exec(config.raw)?.[1];
    const store = name ? android.signingConfigs[name]?.storeFile?.raw : undefined;
    if (DEBUG_SIGNING.test(config.raw) || (store && /debug\.keystore/.test(store))) {
      return [{ key: "debug", message: `The release build is signed with the debug keystore (${config.raw})`, file: config.file, line: config.line, fix: "Create an upload key, keep its passwords in ~/.gradle/gradle.properties, and point a release signingConfig at it." }];
    }
    return [];
  },
};

export const debuggable: Rule = {
  id: "android-debuggable",
  platform: "android",
  severity: "error",
  title: "The release build isn't debuggable",
  why: "Google Play rejects debuggable bundles, and a debuggable release lets anyone attach a debugger to it.",
  docs: ["https://developer.android.com/studio/publish/preparing"],
  checkedOn: "2026-11-04",
  check(project) {
    const android = project.android!;
    const findings: RawFinding[] = [];
    const flag = android.buildTypes.release?.debuggable;
    if (flag?.value === "true") findings.push({ key: "gradle", message: "buildTypes.release sets debuggable true", file: flag.file, line: flag.line, fix: "Remove debuggable from the release build type." });
    for (const manifest of android.manifests.filter((m) => m.sourceSet === "main" || m.sourceSet === "release")) {
      if (manifest.application["android:debuggable"] === "true") {
        findings.push({ key: `manifest:${manifest.sourceSet}`, message: `The ${manifest.sourceSet} manifest sets android:debuggable="true"`, file: manifest.file, line: lineOf(manifest.file, "android:debuggable"), fix: "Remove android:debuggable; Gradle sets it for debug builds." });
      }
    }
    return findings;
  },
};

export const cleartextTraffic: Rule = {
  id: "android-cleartext",
  platform: "android",
  severity: "warning",
  title: "The release build doesn't allow plain-HTTP traffic",
  why: "usesCleartextTraffic lets the release app send data unencrypted. React Native's Gradle plugin turns it on for debug only (for Metro); a hard-coded true leaks into release.",
  docs: ["https://developer.android.com/privacy-and-security/security-config"],
  checkedOn: "2026-11-04",
  check(project) {
    return project.android!.manifests
      .filter((m) => (m.sourceSet === "main" || m.sourceSet === "release") && m.application["android:usesCleartextTraffic"] === "true")
      .map((m) => ({
        key: m.sourceSet,
        message: `The ${m.sourceSet} manifest sets android:usesCleartextTraffic="true"`,
        file: m.file,
        line: lineOf(m.file, "usesCleartextTraffic"),
        fix: 'Use android:usesCleartextTraffic="${usesCleartextTraffic}" (the template\'s placeholder), or a network security config that allows only the hosts you need.',
      }));
  },
};

const TEMPLATE_ICONS = new Set((templateIcons as RuleData<{ sha1: string[] }>).data.sha1);

/** Launcher icon files for a manifest reference like @mipmap/ic_launcher: density folder → file. */
function iconFiles(android: AndroidProject, reference: string) {
  const match = /^@(mipmap|drawable)\/(\w+)$/.exec(reference);
  const res = join(android.appDir, "src", "main", "res");
  if (!match || !isDir(res)) return [];
  const [, type, name] = match;
  return readdirSync(res)
    .filter((folder) => folder === type || folder.startsWith(`${type}-`))
    .flatMap((folder) => ["png", "webp", "xml"].map((ext) => join(res, folder, `${name}.${ext}`)).filter(existsSync));
}

export const launcherIcon: Rule = {
  id: "android-launcher-icon",
  platform: "android",
  severity: "warning",
  title: "The launcher icon is the app's own, with an adaptive version",
  why: "Shipping React Native's template icon looks unfinished and can get flagged in review. Without an adaptive icon, Android 8+ launchers shrink the icon into a white shape.",
  docs: ["https://developer.android.com/develop/ui/views/launch/icon_design_adaptive"],
  checkedOn: (templateIcons as RuleData<unknown>).checkedOn,
  check(project) {
    const android = project.android!;
    const main = android.manifests.find((m) => m.sourceSet === "main");
    if (!main) return [];
    const reference = main.application["android:icon"];
    if (!reference) return [{ key: "missing", message: "The main manifest's <application> has no android:icon", file: main.file, fix: "Add a launcher icon with Android Studio's Image Asset tool and set android:icon." }];
    const files = iconFiles(android, reference);
    if (!files.length) return [];
    const findings: RawFinding[] = [];
    const template = files.filter((file) => file.endsWith(".png") && TEMPLATE_ICONS.has(createHash("sha1").update(readFileSync(file)).digest("hex")));
    if (template.length) {
      findings.push({ key: "template", message: `${reference} is still React Native's template icon`, file: template[0]!, fix: "Replace it with your icon (Android Studio → New → Image Asset generates every size and the adaptive version)." });
    }
    if (!files.some((file) => file.endsWith(".xml"))) {
      findings.push({ key: "adaptive", severity: "info", message: `${reference} has no adaptive icon (mipmap-anydpi-v26)`, file: main.file, line: lineOf(main.file, "android:icon") });
    }
    return findings;
  },
};
