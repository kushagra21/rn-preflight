import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releasePermissions } from "../src/readers/android.js";
import { readProject } from "../src/readers/project.js";
import { clock, cleartextTraffic, debuggable, launcherIcon, releaseSigning, sensitivePermissions, targetSdk } from "../src/rules/android.js";
import { runRules } from "../src/rules/index.js";
import type { Rule } from "../src/rules/types.js";
import { fixture, makeDir, testAppFiles } from "./helpers.js";

const MANIFEST = fixture("testapp/AndroidManifest.xml");
const GRADLE = fixture("testapp/app.build.gradle");
const TOOLS = 'xmlns:tools="http://schemas.android.com/tools"';

/** The template app with edits to its build.gradle and main manifest, plus extra files and dependencies. */
function app(options: { gradle?: (text: string) => string; manifest?: (text: string) => string; files?: Record<string, unknown>; deps?: Record<string, string> } = {}) {
  const files: Record<string, unknown> = {
    ...testAppFiles(),
    "android/app/build.gradle": (options.gradle ?? ((t) => t))(GRADLE),
    "android/app/src/main/AndroidManifest.xml": (options.manifest ?? ((t) => t))(MANIFEST),
    ...options.files,
  };
  if (options.deps) files["package.json"] = { name: "A11yTestApp", dependencies: { "react-native": "0.83.6", ...options.deps } };
  return makeDir(files);
}

const run = (rule: Rule, root: string) => runRules(readProject(root, { platforms: ["android"] }), [rule]);
const summary = (rule: Rule, root: string) => run(rule, root).map((f) => `${f.severity} ${f.message}`);

const androidLib = (name: string, permissions: string) => ({
  [`node_modules/${name}/package.json`]: { name, version: "1.0.0" },
  [`node_modules/${name}/android/build.gradle`]: "",
  [`node_modules/${name}/android/src/main/AndroidManifestNew.xml`]: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">${permissions}</manifest>`,
});
const uses = (name: string, extra = "") => `<uses-permission android:name="android.permission.${name}"${extra}/>`;

afterEach(() => {
  clock.today = () => new Date().toISOString().slice(0, 10);
});

describe("android-target-sdk", () => {
  it("passes the template's 36 today", () => {
    clock.today = () => "2026-11-04";
    expect(run(targetSdk, app())).toEqual([]);
  });

  it("errors below the current requirement and points at the line that sets it", () => {
    clock.today = () => "2026-11-04";
    const root = app({ files: { "android/build.gradle": fixture("testapp/root.build.gradle").replace("targetSdkVersion = 36", "targetSdkVersion = 35") } });
    expect(summary(targetSdk, root)).toEqual(["error targetSdk is 35; Google Play has required 36 for new apps and updates since 2026-08-31"]);
    expect(run(targetSdk, root)[0]).toMatchObject({ file: join(root, "android/app/build.gradle"), line: 84 });
  });

  it("gives notice of the next requirement before it starts", () => {
    clock.today = () => "2026-05-01";
    const root = app({ files: { "android/build.gradle": fixture("testapp/root.build.gradle").replace("targetSdkVersion = 36", "targetSdkVersion = 35") } });
    expect(summary(targetSdk, root)).toEqual(["info targetSdk is 35; Google Play requires 36 from 2026-08-31"]);
  });

  it("skips a computed targetSdk", () => {
    expect(run(targetSdk, app({ gradle: (t) => t.replace("targetSdkVersion rootProject.ext.targetSdkVersion", "targetSdkVersion pickSdk()") }))).toEqual([]);
  });
});

describe("releasePermissions", () => {
  it("merges the app's main and release manifests with libraries', honours tools:node=remove, ignores debug", () => {
    const root = app({
      deps: { camera: "1", media: "1" },
      manifest: (t) => t.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">', `<manifest xmlns:android="http://schemas.android.com/apk/res/android" ${TOOLS}>\n${uses("READ_MEDIA_VIDEO", ' tools:node="remove"')}`),
      files: {
        ...androidLib("camera", uses("CAMERA") + uses("INTERNET")),
        ...androidLib("media", uses("READ_MEDIA_IMAGES") + uses("READ_MEDIA_VIDEO") + uses("READ_EXTERNAL_STORAGE", ' android:maxSdkVersion="32"')),
        "android/app/src/debug/AndroidManifest.xml": `<manifest xmlns:android="http://schemas.android.com/apk/res/android">${uses("SYSTEM_ALERT_WINDOW")}</manifest>`,
        "android/app/src/release/AndroidManifest.xml": `<manifest xmlns:android="http://schemas.android.com/apk/res/android">${uses("VIBRATE")}</manifest>`,
      },
    });
    const project = readProject(root, { platforms: ["android"] });
    expect(releasePermissions(project).map((p) => [p.name.replace("android.permission.", ""), p.sources.join("+"), p.maxSdkVersion ?? ""])).toEqual([
      ["CAMERA", "camera", ""],
      ["INTERNET", "app+camera", ""],
      ["READ_EXTERNAL_STORAGE", "media", "32"],
      ["READ_MEDIA_IMAGES", "media", ""],
      ["VIBRATE", "app", ""],
    ]);
  });

  it("drops maxSdkVersion when another declaration has none", () => {
    const root = app({ deps: { a: "1", b: "1" }, files: { ...androidLib("a", uses("BLUETOOTH", ' android:maxSdkVersion="30"')), ...androidLib("b", uses("BLUETOOTH")) } });
    expect(releasePermissions(readProject(root, { platforms: ["android"] }))[0]).toEqual({ name: "android.permission.BLUETOOTH", sources: ["a", "b"] });
  });
});

describe("android-sensitive-permissions", () => {
  it("names the policy and where each restricted permission comes from", () => {
    const root = app({
      deps: { "media-lib": "1", notify: "1" },
      manifest: (t) => t.replace("<application", `${uses("QUERY_ALL_PACKAGES")}\n    <application`),
      files: {
        ...androidLib("media-lib", uses("READ_MEDIA_IMAGES") + uses("CAMERA")),
        ...androidLib("notify", uses("FOREGROUND_SERVICE") + uses("FOREGROUND_SERVICE_DATA_SYNC") + uses("USE_FULL_SCREEN_INTENT")),
      },
    });
    const findings = run(sensitivePermissions, root);
    expect(findings.map((f) => `${f.severity} ${f.message}`)).toEqual([
      "warning FOREGROUND_SERVICE_DATA_SYNC (Foreground service types policy) comes from notify; Play each foreground service type needs a declaration with a demo video on the App content page",
      "warning QUERY_ALL_PACKAGES (Package Visibility policy) comes from the app's manifest; Play only when the app's core feature needs to see every installed app; use <queries> instead",
      "warning READ_MEDIA_IMAGES (Photo and Video policy) comes from media-lib; Play only for apps whose core feature needs broad photo access; others should use the system photo picker",
      "warning USE_FULL_SCREEN_INTENT (Full-Screen Intent policy) comes from notify; Play only calling and alarm apps keep it by default",
    ]);
    expect(findings[1]!.line).toBe(lineIn(root, "QUERY_ALL_PACKAGES"));
    expect(findings[2]!.fix).toMatch(/tools:node="remove"/);
  });

  it("is quiet for the template and for permissions the app removes", () => {
    expect(run(sensitivePermissions, app())).toEqual([]);
    const root = app({
      deps: { "media-lib": "1" },
      manifest: (t) => t.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">', `<manifest xmlns:android="http://schemas.android.com/apk/res/android" ${TOOLS}>${uses("READ_MEDIA_IMAGES", ' tools:node="remove"')}`),
      files: androidLib("media-lib", uses("READ_MEDIA_IMAGES")),
    });
    expect(run(sensitivePermissions, root)).toEqual([]);
  });
});

function lineIn(root: string, text: string) {
  return readFileSync(join(root, "android/app/src/main/AndroidManifest.xml"), "utf8").split("\n").findIndex((l) => l.includes(text)) + 1;
}

describe("android-release-signing", () => {
  it("flags the template's debug signing", () => {
    expect(summary(releaseSigning, app())).toEqual(["warning The release build is signed with the debug keystore (signingConfigs.debug)"]);
    expect(run(releaseSigning, app())[0]!.line).toBe(103);
  });

  it("follows a named config to its keystore", () => {
    const named = app({ gradle: (t) => t.replace("signingConfigs {", "signingConfigs {\n        upload { storeFile file('debug.keystore') }").replace("signingConfig signingConfigs.debug\n            minifyEnabled", "signingConfig signingConfigs.upload\n            minifyEnabled") });
    expect(summary(releaseSigning, named)).toEqual(["warning The release build is signed with the debug keystore (signingConfigs.upload)"]);
  });

  it("passes a real upload key and notes an unsigned release", () => {
    const real = app({ gradle: (t) => t.replace("signingConfigs {", "signingConfigs {\n        release { storeFile file(MYAPP_UPLOAD_STORE_FILE) }").replace("signingConfig signingConfigs.debug\n            minifyEnabled", "signingConfig signingConfigs.release\n            minifyEnabled") });
    expect(run(releaseSigning, real)).toEqual([]);
    const unsigned = app({ gradle: (t) => t.replace("signingConfig signingConfigs.debug\n            minifyEnabled", "minifyEnabled") });
    expect(summary(releaseSigning, unsigned)).toEqual(["info buildTypes.release sets no signingConfig, so Gradle builds an unsigned bundle"]);
  });

  it("reads Kotlin DSL getByName(\"debug\")", () => {
    const files = testAppFiles();
    delete files["android/app/build.gradle"];
    files["android/app/build.gradle.kts"] = `android {\n  buildTypes {\n    getByName("release") {\n      signingConfig = signingConfigs.getByName("debug")\n    }\n  }\n}`;
    expect(summary(releaseSigning, makeDir(files))).toEqual(['warning The release build is signed with the debug keystore (signingConfigs.getByName("debug"))']);
  });
});

describe("android-debuggable and android-cleartext", () => {
  it("passes the template, whose cleartext flag is a debug-only placeholder", () => {
    expect(run(debuggable, app())).toEqual([]);
    expect(run(cleartextTraffic, app())).toEqual([]);
  });

  it("catches debuggable in Gradle and in the manifest", () => {
    const root = app({
      gradle: (t) => t.replace("signingConfig signingConfigs.debug\n            minifyEnabled", "signingConfig signingConfigs.debug\n            debuggable true\n            minifyEnabled"),
      manifest: (t) => t.replace('android:allowBackup="false"', 'android:allowBackup="false"\n      android:debuggable="true"'),
    });
    expect(summary(debuggable, root)).toEqual(["error buildTypes.release sets debuggable true", 'error The main manifest sets android:debuggable="true"']);
  });

  it("catches cleartext hard-coded on, but not in the debug manifest", () => {
    const root = app({
      manifest: (t) => t.replace('android:usesCleartextTraffic="${usesCleartextTraffic}"', 'android:usesCleartextTraffic="true"'),
      files: { "android/app/src/debug/AndroidManifest.xml": '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:usesCleartextTraffic="true"/></manifest>' },
    });
    expect(summary(cleartextTraffic, root)).toEqual(['warning The main manifest sets android:usesCleartextTraffic="true"']);
  });
});

describe("android-launcher-icon", () => {
  const templateIcon = readFileSync(join(import.meta.dirname, "fixtures/testapp/ic_launcher.png"));

  it("recognises React Native's template icon and a missing adaptive icon", () => {
    const root = app({ files: { "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png": templateIcon } });
    expect(summary(launcherIcon, root)).toEqual([
      "warning @mipmap/ic_launcher is still React Native's template icon",
      "info @mipmap/ic_launcher has no adaptive icon (mipmap-anydpi-v26)",
    ]);
  });

  it("passes the app's own icon with an adaptive version, and flags no icon at all", () => {
    const root = app({
      files: {
        "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png": Buffer.from("my own icon"),
        "android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml": "<adaptive-icon/>",
      },
    });
    expect(run(launcherIcon, root)).toEqual([]);
    expect(summary(launcherIcon, app({ manifest: (t) => t.replace('android:icon="@mipmap/ic_launcher"', "") }))).toEqual(["warning The main manifest's <application> has no android:icon"]);
  });
});
