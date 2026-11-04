import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readPng } from "../core/png.js";
import { isDict } from "../readers/plist.js";
import { infoKeyLocation, infoValue, list } from "./helpers.js";
import type { RawFinding, Rule } from "./types.js";

const CHECKED = "2026-11-04";

export const encryptionFlag: Rule = {
  id: "ios-encryption-flag",
  platform: "ios",
  severity: "info",
  title: "Info.plist answers the export compliance question",
  why: "Without ITSAppUsesNonExemptEncryption, App Store Connect asks about encryption for every build and holds it from TestFlight until someone answers.",
  docs: ["https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations"],
  checkedOn: CHECKED,
  check(project) {
    const ios = project.ios!;
    if (!ios.infoPlist) return [];
    const value = infoValue(ios, "ITSAppUsesNonExemptEncryption");
    if (value === undefined) {
      return [{ key: "missing", message: "ITSAppUsesNonExemptEncryption isn't set", file: ios.infoPlist.file, fix: "Set it to NO if the app only uses HTTPS and Apple's own encryption; set YES and upload export documents otherwise." }];
    }
    if (value === true) {
      return [{ key: "true", message: "ITSAppUsesNonExemptEncryption is YES, so App Store Connect needs export compliance documents", ...infoKeyLocation(ios, "ITSAppUsesNonExemptEncryption") }];
    }
    return [];
  },
};

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|::1|[\w-]+\.local)$/i;

export const transportSecurity: Rule = {
  id: "ios-ats",
  platform: "ios",
  severity: "warning",
  title: "App Transport Security isn't turned off",
  why: "NSAllowsArbitraryLoads lets the app load any plain-HTTP URL. App Review asks for a justification, and it weakens every connection the app makes.",
  docs: ["https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity"],
  checkedOn: CHECKED,
  check(project) {
    const ios = project.ios!;
    const ats = infoValue(ios, "NSAppTransportSecurity");
    if (!isDict(ats)) return [];
    const findings: RawFinding[] = [];
    if (ats.NSAllowsArbitraryLoads === true) {
      findings.push({ key: "arbitrary-loads", message: "NSAllowsArbitraryLoads is YES in the release Info.plist", ...infoKeyLocation(ios, "NSAllowsArbitraryLoads"), fix: "Remove it and add NSExceptionDomains for the few HTTP hosts you need, or move them to HTTPS." });
    }
    const domains = isDict(ats.NSExceptionDomains) ? ats.NSExceptionDomains : {};
    for (const [domain, settings] of Object.entries(domains)) {
      if (LOCAL_HOSTS.test(domain) || !isDict(settings) || settings.NSExceptionAllowsInsecureHTTPLoads !== true) continue;
      findings.push({ key: `http:${domain}`, severity: "info", message: `${domain} is allowed over plain HTTP`, ...infoKeyLocation(ios, domain), fix: "Move that host to HTTPS if you can." });
    }
    return findings;
  },
};

export const sceneLifecycle: Rule = {
  id: "ios-scene-lifecycle",
  platform: "ios",
  severity: "warning",
  title: "The app uses the UIScene life cycle",
  why: "Apple (TN3187): in the major release after iOS 26, apps built with the latest SDK must adopt the UIScene life cycle or they won't launch.",
  docs: ["https://developer.apple.com/documentation/technotes/tn3187-migrating-to-the-uikit-scene-based-life-cycle"],
  checkedOn: CHECKED,
  check(project) {
    const ios = project.ios!;
    if (!ios.infoPlist || isDict(infoValue(ios, "UIApplicationSceneManifest"))) return [];
    return [{ key: "missing", message: "Info.plist has no UIApplicationSceneManifest; built with the iOS 27 SDK the app won't launch", file: ios.infoPlist.file, fix: "Add a SceneDelegate and a UIApplicationSceneManifest (see TN3187)." }];
  },
};

const ALL_ORIENTATIONS = ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"];

export const ipadOrientations: Rule = {
  id: "ios-ipad-orientations",
  platform: "ios",
  severity: "error",
  title: "iPad apps support every orientation, or opt out of multitasking",
  why: "An app that runs on iPad without UIRequiresFullScreen must list all four orientations, or App Store Connect rejects the upload (ITMS-90474).",
  docs: ["https://developer.apple.com/documentation/bundleresources/information-property-list/uisupportedinterfaceorientations"],
  checkedOn: CHECKED,
  check(project) {
    const ios = project.ios!;
    const families = (ios.buildSettings.TARGETED_DEVICE_FAMILY ?? "1").split(",").map((f) => f.trim());
    if (!ios.infoPlist || !families.includes("2") || infoValue(ios, "UIRequiresFullScreen") === true) return [];
    const key = "UISupportedInterfaceOrientations~ipad" in ios.infoPlist.values ? "UISupportedInterfaceOrientations~ipad" : "UISupportedInterfaceOrientations";
    const value = infoValue(ios, key);
    const listed = Array.isArray(value) ? value : [];
    const missing = ALL_ORIENTATIONS.filter((o) => !listed.includes(o));
    if (!missing.length) return [];
    return [{
      key: "missing",
      message: `The app runs on iPad but ${key} lacks ${list(missing.map((o) => o.replace("UIInterfaceOrientation", "")))}`,
      ...infoKeyLocation(ios, key),
      fix: "Add the missing orientations to UISupportedInterfaceOrientations~ipad, or set TARGETED_DEVICE_FAMILY to 1 if the app is iPhone-only.",
    }];
  },
};

export const launchScreen: Rule = {
  id: "ios-launch-screen",
  platform: "ios",
  severity: "error",
  title: "The app has a launch storyboard",
  why: "The App Store requires a launch storyboard (UILaunchStoryboardName); launch images alone aren't accepted.",
  docs: ["https://developer.apple.com/documentation/bundleresources/information-property-list/uilaunchstoryboardname"],
  checkedOn: CHECKED,
  check(project) {
    const ios = project.ios!;
    if (!ios.infoPlist) return [];
    if (!ios.launchStoryboard) {
      return [{ key: "missing", message: "Info.plist sets no UILaunchStoryboardName", file: ios.infoPlist.file, fix: "Add a LaunchScreen.storyboard to the app target and set UILaunchStoryboardName to its name." }];
    }
    if (!ios.launchStoryboard.file) {
      return [{ key: "file", message: `UILaunchStoryboardName is ${ios.launchStoryboard.name}, but there's no ${ios.launchStoryboard.name}.storyboard`, ...infoKeyLocation(ios, "UILaunchStoryboardName") }];
    }
    return [];
  },
};

export const appIcon: Rule = {
  id: "ios-app-icon",
  platform: "ios",
  severity: "error",
  title: "The app icon has an opaque 1024×1024 App Store image",
  why: "App Store Connect rejects builds without a 1024×1024 icon, and ones whose icon has an alpha channel (ITMS-90717).",
  docs: ["https://developer.apple.com/design/human-interface-guidelines/app-icons"],
  checkedOn: CHECKED,
  check(project) {
    const ios = project.ios!;
    const icon = ios.appIcon;
    if (!icon) return [];
    if (icon.composerFile) return [];
    if (!icon.dir) return [{ key: "missing", message: `There's no ${icon.name}.appiconset or ${icon.name}.icon`, fix: "Add an app icon in Xcode (Assets → App Icon), or set ASSETCATALOG_COMPILER_APPICON_NAME to the set you use." }];

    const contents = join(icon.dir, "Contents.json");
    const findings: RawFinding[] = [];
    const store = icon.images.filter((i) => i.size === "1024x1024" && (i.idiom === "ios-marketing" || (i.idiom === "universal" && (i.platform ?? "ios") === "ios")) && !("appearances" in i));
    const withFile = store.filter((i) => i.filename);
    if (!withFile.length) {
      findings.push({ key: "no-1024", message: `${icon.name} has no 1024×1024 App Store image`, file: contents, fix: "Drop a 1024×1024 PNG without transparency into the App Store (or single size) slot." });
    }
    for (const image of icon.images.filter((i) => i.filename)) {
      const file = join(icon.dir, image.filename!);
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch {
        findings.push({ key: `file:${image.filename}`, message: `${image.filename} is listed in ${icon.name} but missing`, file: contents });
        continue;
      }
      const png = readPng(bytes);
      if (!png) {
        findings.push({ key: `png:${image.filename}`, message: `${image.filename} isn't a PNG`, file });
        continue;
      }
      const points = Number(image.size?.split("x")[0]);
      const scale = Number(image.scale?.replace("x", "") || 1);
      const expected = Math.round(points * scale);
      if (expected && (png.width !== expected || png.height !== expected)) {
        findings.push({ key: `size:${image.filename}`, message: `${image.filename} is ${png.width}×${png.height}; its slot (${image.size} @${scale}x) needs ${expected}×${expected}`, file });
      }
      if (store.includes(image) && png.alpha) {
        findings.push({ key: `alpha:${image.filename}`, message: `${relative(icon.dir, file)} has an alpha channel; the App Store icon must be opaque (ITMS-90717)`, file, fix: "Re-export it flattened onto a solid background, with no alpha channel." });
      }
    }
    return findings;
  },
};

const SOCIAL_LOGIN = ["@react-native-google-signin/google-signin", "react-native-google-signin", "react-native-fbsdk-next", "react-native-fbsdk"];
const APPLE_LOGIN = ["@invertase/react-native-apple-authentication", "react-native-apple-authentication", "react-native-apple-sign-in"];

export const loginServices: Rule = {
  id: "ios-login-services",
  platform: "ios",
  severity: "warning",
  title: "Third-party login comes with a private login option",
  why: "Guideline 4.8: apps that use a third-party login (Google, Facebook…) as the main account must also offer an equivalent private option; Sign in with Apple is the usual one. Apps using only their own accounts, or enterprise or education sign-in, are exempt.",
  docs: ["https://developer.apple.com/app-store/review/guidelines/#login-services"],
  checkedOn: CHECKED,
  check(project) {
    const ios = project.ios!;
    const declared = Object.keys(project.declared);
    const social = SOCIAL_LOGIN.filter((name) => declared.includes(name));
    const apple = APPLE_LOGIN.filter((name) => declared.includes(name));
    const entitled = Array.isArray(ios.entitlements?.values["com.apple.developer.applesignin"]);
    const findings: RawFinding[] = [];
    if (social.length && !apple.length && !entitled) {
      findings.push({ key: "no-apple", message: `The app uses ${list(social)} but has no Sign in with Apple`, file: join(project.root, "package.json"), fix: "If these sign people in to their account, add Sign in with Apple (e.g. @invertase/react-native-apple-authentication) or another login that meets 4.8." });
    }
    if (apple.length && !entitled) {
      findings.push({ key: "no-entitlement", message: `${list(apple)} is installed, but the app has no Sign in with Apple entitlement`, ...(ios.entitlements ? { file: ios.entitlements.file } : {}), fix: "Add the Sign in with Apple capability to the app target in Xcode." });
    }
    return findings;
  },
};
