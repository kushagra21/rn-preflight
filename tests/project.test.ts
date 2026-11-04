import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describe as describeProject } from "../src/commands/doctor.js";
import { UserError } from "../src/core/errors.js";
import { readPodfileLock } from "../src/readers/ios.js";
import { readProject } from "../src/readers/project.js";
import { runRules } from "../src/rules/index.js";
import type { Rule } from "../src/rules/types.js";
import { fixture, makeDir, plist, testAppFiles } from "./helpers.js";

describe("the template app", () => {
  const root = makeDir(testAppFiles());
  const project = readProject(root);

  it("reads the iOS target, versions and files", () => {
    const ios = project.ios!;
    expect(ios.target).toBe("A11yTestApp");
    expect(ios.configuration).toBe("Release");
    expect(ios.version).toEqual({ marketing: "1.0", build: "1" });
    expect(ios.buildSettings.PRODUCT_BUNDLE_IDENTIFIER).toBe("org.reactjs.native.example.A11yTestApp");
    expect(ios.infoPlist!.file).toBe(join(root, "ios/A11yTestApp/Info.plist"));
    // $(PRODUCT_MODULE_NAME) in the scene manifest is expanded.
    expect(JSON.stringify(ios.infoPlist!.values.UIApplicationSceneManifest)).toContain("A11yTestApp.SceneDelegate");
    expect(ios.privacyManifestInTarget).toBe(true);
    expect(ios.privacyManifests.map((m) => m.file)).toEqual([join(root, "ios/A11yTestApp/PrivacyInfo.xcprivacy")]);
    expect(ios.privacyManifests[0]!.values!.NSPrivacyTracking).toBe(false);
    expect(ios.launchStoryboard).toEqual({ name: "LaunchScreen", file: join(root, "ios/A11yTestApp/LaunchScreen.storyboard") });
    expect(ios.appIcon!.images.length).toBeGreaterThan(0);
    expect(ios.pods!["RCT-Folly"]).toBe("2024.11.18.00");
  });

  it("reads the Android module, resolving ext and def values", () => {
    const android = project.android!;
    expect(android.applicationId!.value).toBe("com.a11ytestapp");
    expect(android.targetSdk).toMatchObject({ raw: "rootProject.ext.targetSdkVersion", value: "36" });
    expect(android.versionCode!.value).toBe("1");
    expect(android.versionName!.value).toBe("1.0");
    expect(android.buildTypes.release!.signingConfig!.raw).toBe("signingConfigs.debug");
    expect(android.buildTypes.release!.minifyEnabled!.value).toBe("false");
    expect(android.signingConfigs.debug!.storeFile!.raw).toBe("file('debug.keystore')");
    expect(android.manifests.map((m) => m.sourceSet)).toEqual(["main"]);
    expect(android.manifests[0]!.permissions).toEqual([{ name: "android.permission.INTERNET", removed: false }]);
    expect(android.manifests[0]!.application["android:usesCleartextTraffic"]).toBe("${usesCleartextTraffic}");
  });

  it("has nothing to note, and doctor reports no failures", () => {
    expect(project.notes).toEqual([]);
    expect(describeProject(project).every((line) => line.ok)).toBe(true);
  });
});

describe("iOS details", () => {
  it("prefers the Info.plist over INFOPLIST_KEY_ build settings, and records which came from settings", () => {
    const pbx = fixture("testapp/project.pbxproj").replaceAll("MARKETING_VERSION = 1.0;", 'MARKETING_VERSION = 1.0; INFOPLIST_KEY_NSCameraUsageDescription = "Scan receipts"; INFOPLIST_KEY_CFBundleDisplayName = Other;');
    const ios = readProject(makeDir({ ...testAppFiles(), "ios/A11yTestApp.xcodeproj/project.pbxproj": pbx })).ios!;
    expect(ios.infoPlist!.values.NSCameraUsageDescription).toBe("Scan receipts");
    expect(ios.infoPlist!.values.CFBundleDisplayName).toBe("A11yTestApp");
    expect(ios.infoPlist!.keysFromBuildSettings.sort()).toEqual(["CFBundleDisplayName", "NSCameraUsageDescription"]);
  });

  it("uses a literal version in Info.plist over the build setting", () => {
    const info = fixture("testapp/Info.plist").replace("<string>$(MARKETING_VERSION)</string>", "<string>2.3.0</string>");
    expect(readProject(makeDir({ ...testAppFiles(), "ios/A11yTestApp/Info.plist": info })).ios!.version.marketing).toBe("2.3.0");
  });

  it("notices a privacy manifest that isn't in the app target", () => {
    const pbx = fixture("testapp/project.pbxproj").replace(/^.*PrivacyInfo\.xcprivacy in Resources \*\/,\n/m, "");
    const ios = readProject(makeDir({ ...testAppFiles(), "ios/A11yTestApp.xcodeproj/project.pbxproj": pbx })).ios!;
    expect(ios.privacyManifests).toHaveLength(1);
    expect(ios.privacyManifestInTarget).toBe(false);
  });

  it("counts files in an Xcode 16 synchronized folder as in the target, unless excluded", () => {
    const pbx = (exceptions: string) => `// !$*UTF8*$!
{
  objects = {
    P = { isa = PBXProject; buildConfigurationList = PL; targets = (T); };
    PL = { isa = XCConfigurationList; buildConfigurations = (PR); };
    PR = { isa = XCBuildConfiguration; name = Release; buildSettings = { }; };
    T = { isa = PBXNativeTarget; name = A11yTestApp; productType = "com.apple.product-type.application"; buildConfigurationList = TL; buildPhases = (); fileSystemSynchronizedGroups = (G); };
    TL = { isa = XCConfigurationList; buildConfigurations = (TR); };
    TR = { isa = XCBuildConfiguration; name = Release; buildSettings = { INFOPLIST_FILE = A11yTestApp/Info.plist; }; };
    G = { isa = PBXFileSystemSynchronizedRootGroup; path = A11yTestApp; exceptions = (E); sourceTree = "<group>"; };
    E = { isa = PBXFileSystemSynchronizedBuildFileExceptionSet; target = T; membershipExceptions = (${exceptions}); };
  };
  rootObject = P;
}`;
    const read = (exceptions: string) => readProject(makeDir({ ...testAppFiles(), "ios/A11yTestApp.xcodeproj/project.pbxproj": pbx(exceptions) })).ios!;
    expect(read("Info.plist").privacyManifestInTarget).toBe(true);
    expect(read("Info.plist, PrivacyInfo.xcprivacy").privacyManifestInTarget).toBe(false);
  });

  it("explains a missing configuration and a missing Xcode project", () => {
    expect(() => readProject(makeDir(testAppFiles()), { configuration: "Staging" })).toThrow(/no Staging configuration/);
    const files = testAppFiles();
    delete files["ios/A11yTestApp.xcodeproj/project.pbxproj"];
    expect(() => readProject(makeDir(files))).toThrow(/No \.xcodeproj/);
  });

  it("folds subspecs and quoted names in Podfile.lock", () => {
    expect(readPodfileLock(`PODS:\n  - Firebase/Core (11.0.0):\n    - FirebaseCore\n  - "GoogleUtilities/Logger (8.1.0)"\n  - FirebaseCore (11.0.0)\n\nDEPENDENCIES:\n  - Other (1.0)\n`)).toEqual({
      Firebase: "11.0.0",
      GoogleUtilities: "8.1.0",
      FirebaseCore: "11.0.0",
    });
  });

  it("notes a missing Podfile.lock", () => {
    const files = testAppFiles();
    delete files["ios/Podfile.lock"];
    expect(readProject(makeDir(files)).notes.join()).toMatch(/Podfile\.lock is missing/);
  });
});

describe("Android details", () => {
  it("reads a Kotlin DSL module", () => {
    const files = testAppFiles();
    delete files["android/app/build.gradle"];
    files["android/app/build.gradle.kts"] = `plugins { id("com.android.application") }
android {
    namespace = "com.example.kts"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.example.kts"
        targetSdk = 35
        versionCode = 7
        versionName = "2.1"
    }
    signingConfigs { create("upload") { storeFile = file("upload.jks") } }
    buildTypes { getByName("release") { signingConfig = signingConfigs.getByName("upload"); isMinifyEnabled = true } }
}`;
    const android = readProject(makeDir(files)).android!;
    expect([android.namespace?.value, android.applicationId?.value, android.targetSdk?.value, android.versionCode?.value, android.compileSdk?.value]).toEqual(["com.example.kts", "com.example.kts", "35", "7", "36"]);
    expect(Object.keys(android.signingConfigs)).toEqual(["upload"]);
    expect(android.buildTypes.release!.minifyEnabled!.value).toBe("true");
  });

  it("notes a computed versionCode instead of guessing", () => {
    const gradle = fixture("testapp/app.build.gradle").replace("versionCode 1", "versionCode getCodeFromGit()");
    const project = readProject(makeDir({ ...testAppFiles(), "android/app/build.gradle": gradle }));
    expect(project.android!.versionCode).toMatchObject({ raw: "getCodeFromGit()" });
    expect(project.android!.versionCode!.value).toBeUndefined();
    expect(project.notes.join()).toMatch(/versionCode .* is computed \(getCodeFromGit\(\)\)/);
  });

  it("reads debug and release manifests, maxSdkVersion and tools:node=remove", () => {
    const project = readProject(
      makeDir({
        ...testAppFiles(),
        "android/app/src/debug/AndroidManifest.xml": `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
  <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32"/>
  <uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="remove"/>
  <application android:usesCleartextTraffic="true"/>
</manifest>`,
      }),
    );
    const debug = project.android!.manifests.find((m) => m.sourceSet === "debug")!;
    expect(debug.permissions).toEqual([
      { name: "android.permission.READ_EXTERNAL_STORAGE", maxSdkVersion: "32", removed: false },
      { name: "android.permission.RECORD_AUDIO", removed: true },
    ]);
    expect(debug.application).toEqual({ "android:usesCleartextTraffic": "true" });
  });

  it("notes product flavors", () => {
    const gradle = fixture("testapp/app.build.gradle").replace("buildTypes {", 'productFlavors { free { } }\n    buildTypes {');
    expect(readProject(makeDir({ ...testAppFiles(), "android/app/build.gradle": gradle })).notes.join()).toMatch(/product flavors/);
  });
});

describe("native libraries", () => {
  it("follows autolinking: dependencies, devDependencies and peerDependencies with native code only", () => {
    const files = testAppFiles();
    files["package.json"] = {
      dependencies: { "react-native": "0.83.6", camera: "1", lodash: "4" },
      devDependencies: { "dev-native": "1" },
      peerDependencies: { "peer-android": "1" },
    };
    Object.assign(files, {
      "node_modules/camera/package.json": { name: "camera", version: "4.0.0" },
      "node_modules/camera/camera.podspec": "",
      "node_modules/camera/ios/PrivacyInfo.xcprivacy": plist("<dict/>"),
      "node_modules/camera/android/build.gradle": "",
      "node_modules/camera/android/src/main/AndroidManifest.xml": `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.CAMERA"/></manifest>`,
      "node_modules/lodash/package.json": { name: "lodash", version: "4.17.21" },
      "node_modules/dev-native/package.json": { name: "dev-native", version: "1.0.0" },
      "node_modules/dev-native/ios/DevNative.podspec": "",
      "node_modules/peer-android/package.json": { name: "peer-android", version: "1.0.0" },
      "node_modules/peer-android/android/build.gradle.kts": "",
    });
    const root = makeDir(files);
    const libraries = readProject(root).libraries;
    expect(libraries.map((l) => [l.name, l.ios, l.android])).toEqual([
      ["camera", true, true],
      ["dev-native", true, false],
      ["peer-android", false, true],
    ]);
    const camera = libraries[0]!;
    expect(camera.privacyManifests).toEqual([join(root, "node_modules/camera/ios/PrivacyInfo.xcprivacy")]);
    expect(camera.androidManifest!.permissions.map((p) => p.name)).toEqual(["android.permission.CAMERA"]);
  });
});

describe("project errors", () => {
  it("explains what's wrong", () => {
    expect(() => readProject(makeDir({}))).toThrow(UserError);
    expect(() => readProject(makeDir({ "package.json": { dependencies: { expo: "54" } } }))).toThrow(/Expo/);
    expect(() => readProject(makeDir({ "package.json": { dependencies: { "react-native": "0.83.6" } } }))).toThrow(/isn't installed/);
    expect(() => readProject(makeDir({ "package.json": { dependencies: {} } }))).toThrow(/doesn't depend on react-native/);
  });

  it("reads only the platforms asked for, and notes missing folders", () => {
    const files = testAppFiles();
    for (const key of Object.keys(files)) if (key.startsWith("android/")) delete files[key];
    const project = readProject(makeDir(files));
    expect(project.android).toBeUndefined();
    expect(project.notes).toContain("No android/ folder; Android checks are skipped.");
    expect(readProject(makeDir(testAppFiles()), { platforms: ["android"] }).ios).toBeUndefined();
  });
});

describe("runRules", () => {
  const rule = (id: string, platform: Rule["platform"], check: Rule["check"]): Rule => ({
    id, platform, severity: "warning", title: id, why: "", docs: [], checkedOn: "2026-11-04", check,
  });

  it("sorts by severity, skips platforms that weren't read, and turns a crash into a finding", () => {
    const project = readProject(makeDir(testAppFiles()), { platforms: ["ios"] });
    const findings = runRules(project, [
      rule("ios-warn", "ios", () => [{ key: "a", message: "w" }]),
      rule("ios-error", "ios", () => [{ key: "b", message: "e", severity: "error" }]),
      rule("android-only", "android", () => [{ key: "c", message: "never" }]),
      rule("broken", "both", () => {
        throw new Error("boom");
      }),
    ]);
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([
      ["ios-error", "error"],
      ["broken", "warning"],
      ["ios-warn", "warning"],
    ]);
    expect(findings[1]!.message).toMatch(/boom/);
  });
});
