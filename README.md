# rn-preflight

Check a bare React Native app for App Store and Google Play rejection risks before you build and upload: missing or vague permission strings, privacy manifest gaps, icons, restricted Android permissions, debug signing, target SDK, and version numbers.

```bash
npx rn-preflight audit --html preflight-report.html
```

Run it from your app's root. It reads `ios/`, `android/`, `package.json` and `node_modules`; it doesn't build anything, run your code, or send anything anywhere. Needs Node 22.12 or later.

```
✗ AppIcon has no 1024×1024 App Store image ios/MyApp/Images.xcassets/AppIcon.appiconset/Contents.json [ios-app-icon]
  → Drop a 1024×1024 PNG without transparency into the App Store (or single size) slot.
✗ NSCameraUsageDescription is missing; react-native-vision-camera needs it ios/MyApp/Info.plist [ios-usage-string-missing]
  → Add NSCameraUsageDescription to Info.plist with a sentence saying what the app does with it.
! READ_MEDIA_IMAGES (Photo and Video policy) comes from some-media-lib; Play only for apps whose core feature needs broad photo access; others should use the system photo picker [android-sensitive-permissions]
  → If the app doesn't need it, add <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" tools:node="remove"/> to AndroidManifest.xml; otherwise declare it in Play Console.
! The release build is signed with the debug keystore (signingConfigs.debug) android/app/build.gradle:103 [android-release-signing]
  → Create an upload key, keep its passwords in ~/.gradle/gradle.properties, and point a release signingConfig at it.
! versionCode 41 isn't higher than 41 at v2.3.0 android/app/build.gradle:85 [version-bump]
  → Raise versionCode in android/app/build.gradle.

23 rules: 2 errors, 3 warnings, 0 info
```

**Errors** are things the stores reject. **Warnings** often lead to a rejection or a bad release. **Info** is worth a look. `audit` exits with 1 when there are errors, so it can gate CI.

## What it checks

**iOS**

| Rule | Checks |
|---|---|
| `ios-usage-string-missing` | Purpose strings (`NS…UsageDescription`) your native libraries need, including the permissions you turn on with react-native-permissions' `setup_permissions` (ITMS-90683) |
| `ios-usage-string-quality` | Empty, placeholder (`[REASON]`, `TODO`) and vague purpose strings (guideline 5.1.1) |
| `ios-usage-string-translations` | Languages that translate some purpose strings but not all |
| `ios-privacy-manifest` | The app ships a `PrivacyInfo.xcprivacy` that declares the APIs React Native itself uses (ITMS-91053) |
| `ios-privacy-reasons` | Required-reason API categories and reason codes are ones Apple accepts |
| `ios-privacy-pod-apis` | APIs your pods declare are in the app's manifest |
| `ios-privacy-sdk-list` | Pods on Apple's commonly used SDK list ship a privacy manifest and a signature (ITMS-91061) |
| `ios-app-icon` | A 1024×1024 App Store icon with no transparency (ITMS-90717), and every icon at its slot's size |
| `ios-launch-screen` | A launch storyboard exists |
| `ios-ipad-orientations` | iPad apps support every orientation or opt out of multitasking (ITMS-90474) |
| `ios-scene-lifecycle` | The UIScene life cycle, which apps built with the iOS 27 SDK need to launch (Apple TN3187) |
| `ios-ats` | App Transport Security isn't turned off |
| `ios-encryption-flag` | `ITSAppUsesNonExemptEncryption` is set, so builds don't wait on the export question |
| `ios-login-services` | Google or Facebook login comes with Sign in with Apple or another private option (guideline 4.8) |

**Android**

| Rule | Checks |
|---|---|
| `android-target-sdk` | `targetSdk` meets Google Play's current requirement, with notice before the next one |
| `android-sensitive-permissions` | Permissions that need a Play Console declaration (SMS, call log, background location, photos and videos, all files, package visibility, exact alarms, full-screen intents, foreground service types, Health Connect…), and which library adds each |
| `android-release-signing` | The release build isn't signed with `debug.keystore`, as the React Native template does |
| `android-debuggable` | The release build isn't debuggable |
| `android-cleartext` | `usesCleartextTraffic` isn't hard-coded on for release |
| `android-launcher-icon` | The launcher icon isn't React Native's template icon, and has an adaptive version |

**Both**

| Rule | Checks |
|---|---|
| `version-format` | Version numbers the stores accept |
| `versions-match` | iOS and Android show the same version |
| `version-bump` | Build numbers went up since the last release (the latest git tag, or `--since <ref>`) |

`rn-preflight rules` lists them with the date each was last checked against Apple's and Google's documentation. Store rules change every year; the date tells you how fresh a rule is.

## The report

`audit --html <file>` writes a single HTML file you can open locally or keep as a CI artifact. It loads nothing from anywhere and runs only its own script, pinned by a content security policy. Filter by severity or platform; each finding says why it matters, with links to Apple's and Google's documentation.

## Accepting a finding

Some findings are fine for your app; say why, and `audit` stops counting them:

```bash
npx rn-preflight ignore android-release-signing debug --reason "CI signs the bundle with the upload key"
```

That writes the finding to `preflight.config.json`, which you commit:

```json
{
  "ignore": [
    { "rule": "android-release-signing", "key": "debug", "reason": "CI signs the bundle with the upload key", "date": "2026-11-04" }
  ]
}
```

In the report, **Ignore…** on a finding asks for the reason and copies this command for you. `audit` tells you when an ignored finding no longer happens, so the file doesn't collect stale entries.

## Commands

```
rn-preflight audit    Check the app; exits with 1 when there are errors
  --html <file>       also write the HTML report
  --json              print the findings as JSON
  --since <ref>       the release to compare version numbers with (default: the latest git tag)
  --no-git            don't compare version numbers with git
rn-preflight ignore <rule> <key> --reason <text>
rn-preflight rules    List the checks and when each was last checked
rn-preflight doctor   Show what it found: targets, files, versions, release permissions
```

Every command that reads the app takes `-C <dir>`, `-p ios|android|both`, `--xcodeproj`, `--target`, `--configuration` (default `Release`) and `--android-module`.

## What it can't see

It reads your source, so some things need a built app to know for sure (a later version will scan `.ipa` and `.aab` files):

- Which required-reason APIs your compiled code really calls; Apple checks the binary.
- Permissions added by prebuilt Android libraries (React Native's own, Maven dependencies); it reads your manifests and your React Native libraries' manifests.
- Anything set by code in Gradle files (a `versionCode` computed from git, for example) is reported as unresolved, never guessed.
- `react-native.config.js` overrides of autolinking; every native dependency is treated as linked.
- Purpose strings for libraries outside its list; the list only has keys each library's documentation asks for.

Expo apps work when `ios/` and `android/` exist (for example after `npx expo prebuild`); apps that generate them on each build aren't supported yet.

## License

MIT
