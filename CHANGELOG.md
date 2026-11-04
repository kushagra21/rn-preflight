# Changelog

## 0.1.0 (2026-11-04)

First release.

- `audit`: 23 rules for bare React Native apps (14 iOS, 6 Android, 3 for both), read from source without a build. Exits with 1 when there are errors.
- iOS: purpose strings native libraries and react-native-permissions handlers need; empty, placeholder, vague and untranslated purpose strings; the privacy manifest (React Native's own APIs, Apple's reason codes, APIs pods declare, Apple's SDK list with signatures); the 1024 App Store icon (transparency decoded from the pixels) and icon sizes; launch storyboard; iPad orientations; the UIScene life cycle; App Transport Security; the encryption flag; login services.
- Android: target SDK against Google Play's dated requirement; restricted permissions in the merged release manifest with the library that adds each; debug-keystore release signing; debuggable releases; cleartext traffic; React Native's template launcher icon and adaptive icons.
- Versions: formats the stores accept, iOS and Android matching, and build numbers raised since the latest git tag (or `--since`).
- `audit --html`: a single-file report with a hash-pinned content security policy, severity and platform filters, and an Ignore button that copies the matching command.
- `ignore` and `preflight.config.json`: accept a finding with a reason; stale entries are reported.
- `rules` lists each rule with the date it was last checked against the stores' documentation. `doctor` shows what was read, including the release permissions.
- Reads Groovy and Kotlin Gradle files, Xcode 16 synchronized folders, apps inside a monorepo, and bare apps that use Expo modules.
- Checked on two bare React Native 0.83 apps and on the source of BlueWallet, Rainbow and Mattermost.
