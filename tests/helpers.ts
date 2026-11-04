import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A temporary folder with the given files; strings and Buffers are written as they are, other values as JSON. */
export function makeDir(files: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rn-preflight-")));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
  return root;
}

/** A file from tests/fixtures. */
export const fixture = (path: string) => readFileSync(join(import.meta.dirname, "fixtures", path), "utf8");

/** The real files of a bare RN 0.83.6 app (rn-a11y-testapp), laid out as the template makes them. */
export const testAppFiles = (): Record<string, unknown> => ({
  "package.json": { name: "A11yTestApp", dependencies: { react: "19.2.0", "react-native": "0.83.6" } },
  "node_modules/react-native/package.json": { name: "react-native", version: "0.83.6" },
  "ios/A11yTestApp.xcodeproj/project.pbxproj": fixture("testapp/project.pbxproj"),
  "ios/A11yTestApp/Info.plist": fixture("testapp/Info.plist"),
  "ios/A11yTestApp/PrivacyInfo.xcprivacy": fixture("testapp/PrivacyInfo.xcprivacy"),
  "ios/A11yTestApp/LaunchScreen.storyboard": "<document/>",
  "ios/A11yTestApp/Images.xcassets/AppIcon.appiconset/Contents.json": fixture("testapp/AppIcon.Contents.json"),
  "ios/Podfile": "",
  "ios/Podfile.lock": fixture("testapp/Podfile.lock"),
  "android/build.gradle": fixture("testapp/root.build.gradle"),
  "android/gradle.properties": "hermesEnabled=true\nnewArchEnabled=true\n",
  "android/app/build.gradle": fixture("testapp/app.build.gradle"),
  "android/app/src/main/AndroidManifest.xml": fixture("testapp/AndroidManifest.xml"),
});

export const plist = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`;
