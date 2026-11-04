import type { PlistDict } from "../readers/plist.js";

/** A value read from a Gradle file: `raw` is the expression as written, `value` what it resolves to, when it does. */
export interface GradleValue {
  raw: string;
  value?: string;
  file: string;
  line?: number;
}

export interface IosProject {
  dir: string;
  xcodeproj: string;
  target: string;
  configuration: string;
  /** The target's build settings for `configuration`, project settings included and $(VARS) expanded. */
  buildSettings: Record<string, string>;
  infoPlist?: {
    file: string;
    /** Values with $(VARS) expanded; INFOPLIST_KEY_* build settings merged in under the file's own keys. */
    values: PlistDict;
    keysFromBuildSettings: string[];
  };
  /** InfoPlist.strings per .lproj language next to Info.plist. */
  infoPlistStrings?: { language: string; file: string; values: Record<string, string> }[];
  version: { marketing?: string; build?: string };
  /**
   * PrivacyInfo.xcprivacy files in ios/ (app extensions' too), each with whether the app target copies it into the
   * app, and whether the target copies any.
   */
  privacyManifests: { file: string; inTarget: boolean; values?: PlistDict; error?: string }[];
  privacyManifestInTarget: boolean;
  entitlements?: { file: string; values: PlistDict };
  appIcon?: { name: string; dir?: string; composerFile?: string; images: AppIconImage[] };
  launchStoryboard?: { name: string; file?: string };
  /** Pods from Podfile.lock, name to version; subspecs (Foo/Bar) are folded into Foo. */
  pods?: Record<string, string>;
  /** ios/Pods, when pod install has run. */
  podsDir?: string;
  /** react-native-permissions handlers from setup_permissions in the Podfile. */
  podfilePermissions?: string[];
}

export interface AppIconImage {
  filename?: string;
  idiom?: string;
  size?: string;
  scale?: string;
  platform?: string;
}

export interface ManifestPermission {
  name: string;
  maxSdkVersion?: string;
  /** tools:node="remove": the app strips a permission a library adds. */
  removed: boolean;
}

export interface AndroidManifestFile {
  file: string;
  /** main, debug, release or a flavor's folder name. */
  sourceSet: string;
  package?: string;
  permissions: ManifestPermission[];
  application: Record<string, string>;
  error?: string;
}

export interface AndroidProject {
  dir: string;
  appDir: string;
  buildFile: string;
  applicationId?: GradleValue;
  namespace?: GradleValue;
  versionCode?: GradleValue;
  versionName?: GradleValue;
  minSdk?: GradleValue;
  targetSdk?: GradleValue;
  compileSdk?: GradleValue;
  signingConfigs: Record<string, { storeFile?: GradleValue; line?: number }>;
  buildTypes: Record<string, { signingConfig?: GradleValue; minifyEnabled?: GradleValue; debuggable?: GradleValue; line?: number }>;
  gradleProperties: Record<string, string>;
  manifests: AndroidManifestFile[];
}

/** A package the app's native builds link (React Native autolinking's rules). */
export interface NativeLibrary {
  name: string;
  version?: string;
  dir: string;
  ios: boolean;
  android: boolean;
  privacyManifests: string[];
  androidManifest?: AndroidManifestFile;
}

/** Versions at an earlier commit (by default the latest tag), to check that this build raises them. */
export interface PreviousVersions {
  ref?: string;
  ios?: { marketing?: string; build?: string };
  android?: { versionName?: string; versionCode?: string };
  /** Why there's nothing to compare with. */
  note?: string;
}

export interface Project {
  root: string;
  name?: string;
  reactNative: string;
  /** Names in dependencies, devDependencies and peerDependencies. */
  declared: Record<string, string>;
  ios?: IosProject;
  android?: AndroidProject;
  libraries: NativeLibrary[];
  /** Filled in by audit; rules that need it skip when it's missing. */
  previous?: PreviousVersions;
  /** Things the readers couldn't resolve or had to guess; doctor shows them. */
  notes: string[];
}

export type Platform = "ios" | "android";
