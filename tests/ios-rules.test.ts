import { describe, expect, it } from "vitest";
import { readPng } from "../src/core/png.js";
import { readPodfilePermissions } from "../src/readers/ios.js";
import { readProject } from "../src/readers/project.js";
import { parseStrings } from "../src/readers/strings.js";
import { appIcon, encryptionFlag, ipadOrientations, launchScreen, loginServices, sceneLifecycle, transportSecurity } from "../src/rules/ios-app.js";
import { privacyManifestPresent, privacyPodApis, privacyReasons, privacySdkList } from "../src/rules/ios-privacy.js";
import { purposeProblem, usageStringMissing, usageStringQuality, usageStringTranslations } from "../src/rules/ios-usage.js";
import { runRules } from "../src/rules/index.js";
import type { Rule } from "../src/rules/types.js";
import { fixture, makeDir, plist, testAppFiles } from "./helpers.js";

/** The template app with extra Info.plist entries (raw XML) and keys removed. */
function app(options: { info?: string; removeInfo?: string[]; files?: Record<string, unknown>; deps?: Record<string, string> } = {}) {
  let info = fixture("testapp/Info.plist");
  for (const key of options.removeInfo ?? []) info = info.replace(new RegExp(`\\s*<key>${key}</key>\\s*<(string|true|false)\\s*/?>(?:[^<]*</string>)?`), "");
  if (options.info) info = info.replace(/<\/dict>\s*<\/plist>\s*$/, `${options.info}\n</dict>\n</plist>\n`);
  const files: Record<string, unknown> = { ...testAppFiles(), "ios/A11yTestApp/Info.plist": info, ...options.files };
  if (options.deps) files["package.json"] = { name: "A11yTestApp", dependencies: { "react-native": "0.83.6", ...options.deps } };
  return makeDir(files);
}

const run = (rule: Rule, root: string) => runRules(readProject(root, { platforms: ["ios"] }), [rule]);
const summary = (rule: Rule, root: string) => run(rule, root).map((f) => `${f.severity} ${f.message}`);

/** A PNG header with the given size and color type (6 = RGBA, 2 = RGB); enough for readPng. */
function png(size: number, colorType = 2, chunks: string[] = []) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...chunks.map((type) => chunk(type, Buffer.alloc(2))),
    chunk("IDAT", Buffer.alloc(4)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const nativeLib = (name: string) => ({
  [`node_modules/${name}/package.json`]: { name, version: "1.0.0" },
  [`node_modules/${name}/${name.split("/").pop()}.podspec`]: "",
});

describe("ios-usage-string-missing", () => {
  it("needs the keys a library always uses, and warns about the ones it uses for some features", () => {
    const root = app({ deps: { "react-native-vision-camera": "4" }, files: nativeLib("react-native-vision-camera") });
    expect(summary(usageStringMissing, root)).toEqual([
      "error NSCameraUsageDescription is missing; react-native-vision-camera needs it",
      "warning NSMicrophoneUsageDescription is missing; react-native-vision-camera needs it if you record video with audio",
    ]);
  });

  it("is satisfied by keys in Info.plist, and ignores JS-only installs of the same name", () => {
    const root = app({ deps: { "react-native-vision-camera": "4" }, files: nativeLib("react-native-vision-camera"), info: "<key>NSCameraUsageDescription</key><string>x</string><key>NSMicrophoneUsageDescription</key><string>y</string>" });
    expect(run(usageStringMissing, root)).toEqual([]);
    const jsOnly = app({ deps: { "react-native-contacts": "8" }, files: { "node_modules/react-native-contacts/package.json": { name: "react-native-contacts" } } });
    expect(run(usageStringMissing, jsOnly)).toEqual([]);
  });

  it("makes a key required when one library always needs it, even if another only sometimes does", () => {
    const root = app({
      deps: { "react-native-image-picker": "7", "react-native-document-scanner-plugin": "1" },
      files: { ...nativeLib("react-native-image-picker"), ...nativeLib("react-native-document-scanner-plugin") },
      info: "<key>NSPhotoLibraryUsageDescription</key><string>x</string><key>NSMicrophoneUsageDescription</key><string>x</string>",
    });
    expect(summary(usageStringMissing, root)).toEqual(["error NSCameraUsageDescription is missing; react-native-document-scanner-plugin and react-native-image-picker need it"]);
  });

  it("reads react-native-permissions handlers from the Podfile, skipping commented ones", () => {
    const podfile = `setup_permissions([\n  'Camera',\n  # 'Contacts',\n  "LocationWhenInUse", 'Notifications',\n])`;
    expect(readPodfilePermissions(podfile)).toEqual(["Camera", "LocationWhenInUse", "Notifications"]);
    expect(readPodfilePermissions("target 'x' do\nend")).toBeUndefined();
    const root = app({ files: { "ios/Podfile": podfile } });
    // The template's empty location key counts as present; its emptiness is the quality rule's job.
    expect(summary(usageStringMissing, root)).toEqual(["error NSCameraUsageDescription is missing; react-native-permissions (Camera) needs it"]);
  });
});

describe("ios-usage-string-quality", () => {
  it.each([
    ["", "error"],
    ["[REASON]", "error"],
    ["TODO write this", "error"],
    ["App needs camera access", "warning"],
    ["This app requires access to your photos.", "warning"],
    ["MyApp needs access to your location", "warning"],
    ["Camera access", "warning"],
    ["The camera scans receipts so you don't have to type them.", undefined],
    ["Your location shows nearby stores and their opening hours.", undefined],
  ])("%j → %s", (text, severity) => {
    expect(purposeProblem(text)?.severity).toBe(severity);
  });

  it("calls an empty key an error when a library needs it, and a leftover to remove when none does", () => {
    expect(summary(usageStringQuality, app())).toEqual(["warning NSLocationWhenInUseUsageDescription is empty, and no native library here asks for it"]);
    const root = app({ deps: { "@react-native-community/geolocation": "3" }, files: nativeLib("@react-native-community/geolocation") });
    expect(summary(usageStringQuality, root)).toEqual(["error NSLocationWhenInUseUsageDescription is empty"]);
    expect(run(usageStringQuality, root)[0]!.line).toBe(36);
  });

  it("checks translated strings, including UTF-16 files", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('/* c */\n"NSCameraUsageDescription" = "[REASON]";\n', "utf16le")]);
    expect(parseStrings(utf16)).toEqual({ NSCameraUsageDescription: "[REASON]" });
    const root = app({ removeInfo: ["NSLocationWhenInUseUsageDescription"], files: { "ios/A11yTestApp/de.lproj/InfoPlist.strings": utf16 } });
    expect(summary(usageStringQuality, root)).toEqual(['error NSCameraUsageDescription (de) is a placeholder ("[REASON]")']);
  });
});

describe("ios-usage-string-translations", () => {
  it("lists purpose strings a translation leaves out", () => {
    const root = app({
      removeInfo: ["NSLocationWhenInUseUsageDescription"],
      info: "<key>NSCameraUsageDescription</key><string>Scans receipts for your expense reports.</string><key>NSContactsUsageDescription</key><string>Finds friends who already use the app.</string>",
      files: { "ios/A11yTestApp/de.lproj/InfoPlist.strings": '"NSCameraUsageDescription" = "Scannt Belege für Ihre Spesen.";\n', "ios/A11yTestApp/fr.lproj/InfoPlist.strings": 'NSCameraUsageDescription = "x"; NSContactsUsageDescription = "y";' },
    });
    expect(summary(usageStringTranslations, root)).toEqual(["info de.lproj/InfoPlist.strings doesn't translate NSContactsUsageDescription"]);
  });
});

const manifest = (entries: [string, string[]][], extra = "") =>
  plist(`<dict><key>NSPrivacyAccessedAPITypes</key><array>${entries
    .map(([type, reasons]) => `<dict><key>NSPrivacyAccessedAPIType</key><string>${type}</string><key>NSPrivacyAccessedAPITypeReasons</key><array>${reasons.map((r) => `<string>${r}</string>`).join("")}</array></dict>`)
    .join("")}</array>${extra}</dict>`);
const CORE: [string, string[]][] = [
  ["NSPrivacyAccessedAPICategoryFileTimestamp", ["C617.1"]],
  ["NSPrivacyAccessedAPICategoryUserDefaults", ["CA92.1"]],
  ["NSPrivacyAccessedAPICategorySystemBootTime", ["35F9.1"]],
];

describe("ios-privacy-manifest", () => {
  it("passes the template after pod install", () => {
    expect(run(privacyManifestPresent, app())).toEqual([]);
  });

  it("flags a missing manifest and React Native's own APIs left out", () => {
    const files = testAppFiles();
    delete files["ios/A11yTestApp/PrivacyInfo.xcprivacy"];
    expect(summary(privacyManifestPresent, makeDir(files))).toEqual(["error The app has no PrivacyInfo.xcprivacy"]);
    const partial = app({ files: { "ios/A11yTestApp/PrivacyInfo.xcprivacy": manifest([CORE[0]!]) } });
    expect(summary(privacyManifestPresent, partial)).toEqual(["error PrivacyInfo.xcprivacy doesn't declare UserDefaults and SystemBootTime, which React Native itself uses"]);
  });

  it("tells apart a manifest pod install hasn't added yet from one that won't ship", () => {
    const pbx = fixture("testapp/project.pbxproj").replace(/^.*PrivacyInfo\.xcprivacy in Resources \*\/,\n/m, "");
    expect(summary(privacyManifestPresent, app({ files: { "ios/A11yTestApp.xcodeproj/project.pbxproj": pbx } }))).toEqual([
      "error PrivacyInfo.xcprivacy isn't in A11yTestApp's Copy Bundle Resources, so it won't ship",
    ]);
    const files: Record<string, unknown> = { ...testAppFiles(), "ios/A11yTestApp.xcodeproj/project.pbxproj": pbx };
    delete files["ios/Podfile.lock"];
    expect(summary(privacyManifestPresent, makeDir(files))).toEqual(["info PrivacyInfo.xcprivacy isn't in A11yTestApp's resources yet; pod install adds it"]);
  });
});

describe("ios-privacy-reasons", () => {
  it("checks categories, reason codes and tracking domains", () => {
    const bad = manifest(
      [...CORE, ["NSPrivacyAccessedAPICategoryDiskSpaces", ["E174.1"]], ["NSPrivacyAccessedAPICategoryDiskSpace", ["C617.1", "E174.1"]], ["NSPrivacyAccessedAPICategoryActiveKeyboards", []]],
      "<key>NSPrivacyTracking</key><true/>",
    );
    expect(summary(privacyReasons, app({ files: { "ios/A11yTestApp/PrivacyInfo.xcprivacy": bad } }))).toEqual([
      "error NSPrivacyAccessedAPICategoryDiskSpaces isn't a required-reason API category",
      "error C617.1 isn't a reason Apple accepts for DiskSpace",
      "error ActiveKeyboards is declared with no reason",
      "warning NSPrivacyTracking is true but NSPrivacyTrackingDomains is empty",
    ]);
    expect(run(privacyReasons, app())).toEqual([]);
  });
});

describe("ios-privacy-pod-apis", () => {
  it("lists categories pods declare that the app's manifest lacks", () => {
    const disk = manifest([["NSPrivacyAccessedAPICategoryDiskSpace", ["E174.1"]]]);
    const root = app({
      deps: { "react-native-fs": "2" },
      files: { ...nativeLib("react-native-fs"), "node_modules/react-native-fs/PrivacyInfo.xcprivacy": disk, "ios/Pods/SomePod/Resources/PrivacyInfo.xcprivacy": disk, "ios/Pods/Clean/PrivacyInfo.xcprivacy": manifest([CORE[0]!]) },
    });
    expect(summary(privacyPodApis, root)).toEqual(["warning SomePod and react-native-fs declare DiskSpace, but the app's PrivacyInfo.xcprivacy doesn't"]);
  });
});

describe("ios-privacy-sdk-list", () => {
  const lock = fixture("testapp/Podfile.lock").replace("PODS:\n", "PODS:\n  - SDWebImage (5.10.0):\n    - SDWebImage/Core (= 5.10.0)\n  - FBSDKCoreKit (17.0.0)\n");

  it("flags listed pods without a manifest and unsigned binary frameworks", () => {
    const root = app({
      files: {
        "ios/Podfile.lock": lock,
        "ios/Pods/SDWebImage/SDWebImage/Core/SDImageCache.m": "",
        "ios/Pods/FBSDKCoreKit/XCFrameworks/FBSDKCoreKit.xcframework/ios-arm64/FBSDKCoreKit.framework/PrivacyInfo.xcprivacy": plist("<dict/>"),
      },
    });
    expect(summary(privacySdkList, root)).toEqual([
      "error SDWebImage 5.10.0 (SDWebImage on Apple's list) has no privacy manifest",
      "warning XCFrameworks/FBSDKCoreKit.xcframework in FBSDKCoreKit isn't signed; Apple asks for signatures on binary SDKs from its list",
    ]);
  });

  it("passes pods that ship a manifest and signature, and skips the check before pod install", () => {
    const root = app({
      files: {
        "ios/Podfile.lock": lock,
        "ios/Pods/SDWebImage/WebImage/PrivacyInfo.xcprivacy": plist("<dict/>"),
        "ios/Pods/FBSDKCoreKit/XCFrameworks/FBSDKCoreKit.xcframework/_CodeSignature/CodeResources": "",
        "ios/Pods/FBSDKCoreKit/XCFrameworks/FBSDKCoreKit.xcframework/ios-arm64/FBSDKCoreKit.framework/PrivacyInfo.xcprivacy": plist("<dict/>"),
      },
    });
    expect(run(privacySdkList, root)).toEqual([]);
    expect(run(privacySdkList, app({ files: { "ios/Podfile.lock": lock } }))).toEqual([]);
  });
});

describe("ios-app-icon", () => {
  const set = "ios/A11yTestApp/Images.xcassets/AppIcon.appiconset";
  const contents = (images: object[]) => ({ [`${set}/Contents.json`]: { images, info: { version: 1 } } });

  it("reads PNG size and transparency", () => {
    expect(readPng(png(1024))).toEqual({ width: 1024, height: 1024, alpha: false });
    expect(readPng(png(1024, 6))!.alpha).toBe(true);
    expect(readPng(png(1024, 2, ["tRNS"]))!.alpha).toBe(true);
    expect(readPng(Buffer.from("GIF89a"))).toBeUndefined();
  });

  it("needs a 1024 App Store image (the template has none)", () => {
    expect(summary(appIcon, app())).toEqual(["error AppIcon has no 1024×1024 App Store image"]);
  });

  it("accepts an opaque single-size icon, and rejects alpha and wrong sizes", () => {
    const single = { idiom: "universal", platform: "ios", size: "1024x1024", filename: "icon.png" };
    expect(run(appIcon, app({ files: { ...contents([single]), [`${set}/icon.png`]: png(1024) } }))).toEqual([]);

    const images = [single, { idiom: "iphone", size: "60x60", scale: "3x", filename: "small.png" }, { idiom: "iphone", size: "40x40", scale: "2x", filename: "gone.png" }];
    const root = app({ files: { ...contents(images), [`${set}/icon.png`]: png(1024, 6), [`${set}/small.png`]: png(120) } });
    expect(summary(appIcon, root)).toEqual([
      "error icon.png has an alpha channel; the App Store icon must be opaque (ITMS-90717)",
      "error small.png is 120×120; its slot (60x60 @3x) needs 180×180",
      "error gone.png is listed in AppIcon but missing",
    ]);
  });

  it("leaves Icon Composer icons alone, and flags a missing icon set", () => {
    expect(run(appIcon, app({ files: { "ios/AppIcon.icon/icon.json": {} } }))).toEqual([]);
    const files = testAppFiles();
    delete files[`${set}/Contents.json`];
    expect(summary(appIcon, makeDir(files))).toEqual(["error There's no AppIcon.appiconset or AppIcon.icon"]);
  });
});

describe("other Info.plist rules", () => {
  it("ios-launch-screen", () => {
    expect(run(launchScreen, app())).toEqual([]);
    expect(summary(launchScreen, app({ removeInfo: ["UILaunchStoryboardName"] }))).toEqual(["error Info.plist sets no UILaunchStoryboardName"]);
    const files = testAppFiles();
    delete files["ios/A11yTestApp/LaunchScreen.storyboard"];
    expect(summary(launchScreen, makeDir(files))).toEqual(["error UILaunchStoryboardName is LaunchScreen, but there's no LaunchScreen.storyboard"]);
  });

  it("ios-ipad-orientations", () => {
    expect(run(ipadOrientations, app())).toEqual([]);
    const ipad = fixture("testapp/project.pbxproj").replaceAll("MARKETING_VERSION = 1.0;", 'MARKETING_VERSION = 1.0; TARGETED_DEVICE_FAMILY = "1,2";');
    const files = { "ios/A11yTestApp.xcodeproj/project.pbxproj": ipad };
    expect(summary(ipadOrientations, app({ files }))).toEqual(["error The app runs on iPad but UISupportedInterfaceOrientations lacks PortraitUpsideDown"]);
    expect(run(ipadOrientations, app({ files, info: "<key>UIRequiresFullScreen</key><true/>" }))).toEqual([]);
    const all = "<key>UISupportedInterfaceOrientations~ipad</key><array><string>UIInterfaceOrientationPortrait</string><string>UIInterfaceOrientationPortraitUpsideDown</string><string>UIInterfaceOrientationLandscapeLeft</string><string>UIInterfaceOrientationLandscapeRight</string></array>";
    expect(run(ipadOrientations, app({ files, info: all }))).toEqual([]);
  });

  it("ios-scene-lifecycle", () => {
    expect(run(sceneLifecycle, app())).toEqual([]);
    const info = fixture("testapp/Info.plist").replace(/<key>UIApplicationSceneManifest<\/key>[\s\S]*?(?=<key>UILaunchStoryboardName)/, "");
    expect(summary(sceneLifecycle, app({ files: { "ios/A11yTestApp/Info.plist": info } }))).toEqual([
      "warning Info.plist has no UIApplicationSceneManifest; built with the iOS 27 SDK the app won't launch",
    ]);
  });

  it("ios-ats", () => {
    expect(run(transportSecurity, app())).toEqual([]);
    const info = fixture("testapp/Info.plist").replace(
      "<key>NSAllowsArbitraryLoads</key>\n\t\t<false/>",
      "<key>NSAllowsArbitraryLoads</key><true/><key>NSExceptionDomains</key><dict><key>localhost</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict><key>api.example.com</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict></dict>",
    );
    expect(summary(transportSecurity, app({ files: { "ios/A11yTestApp/Info.plist": info } }))).toEqual([
      "warning NSAllowsArbitraryLoads is YES in the release Info.plist",
      "info api.example.com is allowed over plain HTTP",
    ]);
  });

  it("ios-encryption-flag", () => {
    expect(summary(encryptionFlag, app())).toEqual(["info ITSAppUsesNonExemptEncryption isn't set"]);
    expect(run(encryptionFlag, app({ info: "<key>ITSAppUsesNonExemptEncryption</key><false/>" }))).toEqual([]);
    expect(run(encryptionFlag, app({ info: "<key>ITSAppUsesNonExemptEncryption</key><true/>" }))[0]!.message).toMatch(/export compliance/);
  });

  it("ios-login-services", () => {
    expect(run(loginServices, app())).toEqual([]);
    expect(summary(loginServices, app({ deps: { "@react-native-google-signin/google-signin": "13" } }))).toEqual([
      "warning The app uses @react-native-google-signin/google-signin but has no Sign in with Apple",
    ]);
    expect(summary(loginServices, app({ deps: { "@react-native-google-signin/google-signin": "13", "@invertase/react-native-apple-authentication": "2" } }))).toEqual([
      "warning @invertase/react-native-apple-authentication is installed, but the app has no Sign in with Apple entitlement",
    ]);
    const entitled = fixture("testapp/project.pbxproj").replaceAll("MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 1.0; CODE_SIGN_ENTITLEMENTS = A11yTestApp/App.entitlements;");
    const root = app({
      deps: { "@react-native-google-signin/google-signin": "13", "@invertase/react-native-apple-authentication": "2" },
      files: { "ios/A11yTestApp.xcodeproj/project.pbxproj": entitled, "ios/A11yTestApp/App.entitlements": plist("<dict><key>com.apple.developer.applesignin</key><array><string>Default</string></array></dict>") },
    });
    expect(run(loginServices, root)).toEqual([]);
  });
});
