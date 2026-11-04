import { relative } from "node:path";
import pc from "picocolors";
import { UserError } from "../core/errors.js";
import type { GradleValue, Project } from "../core/types.js";
import { readProject, type ReadOptions } from "../readers/project.js";

export interface Line {
  ok: boolean;
  /** Not having it is fine, just worth knowing. */
  optional?: boolean;
  label: string;
  detail: string;
}

const gradle = (v: GradleValue | undefined) => (v === undefined ? "not set" : (v.value ?? `${v.raw} (computed)`));

/** What rn-preflight found in the project, as doctor prints it. */
export function describe(project: Project): Line[] {
  const rel = (path: string) => relative(project.root, path) || ".";
  const lines: Line[] = [{ ok: true, label: "Project", detail: `${project.name ?? "(unnamed)"}, bare React Native ${project.reactNative}` }];

  const ios = project.ios;
  if (ios) {
    lines.push({ ok: true, label: "Xcode target", detail: `${rel(ios.xcodeproj)} → ${ios.target} (${ios.configuration})` });
    lines.push({ ok: !!ios.infoPlist, label: "Info.plist", detail: ios.infoPlist ? `${rel(ios.infoPlist.file)}, ${Object.keys(ios.infoPlist.values).length} keys` : "not found" });
    lines.push({ ok: !!(ios.version.marketing && ios.version.build), label: "iOS version", detail: `${ios.version.marketing ?? "?"} (${ios.version.build ?? "?"})` });
    const appManifest = ios.privacyManifests.map((m) => rel(m.file)).join(", ");
    lines.push({
      ok: ios.privacyManifestInTarget,
      optional: true,
      label: "Privacy manifest",
      detail: ios.privacyManifests.length ? `${appManifest}${ios.privacyManifestInTarget ? "" : ", not in the app target's resources"}` : "none",
    });
    const icons = ios.appIcon?.images.filter((i) => i.filename).length ?? 0;
    lines.push({ ok: !!ios.appIcon?.dir, optional: true, label: "App icon", detail: ios.appIcon?.dir ? `${rel(ios.appIcon.dir)}, ${icons} image${icons === 1 ? "" : "s"}` : `no ${ios.appIcon?.name}.appiconset` });
    lines.push({ ok: !!ios.launchStoryboard?.file, optional: true, label: "Launch screen", detail: ios.launchStoryboard ? (ios.launchStoryboard.file ? rel(ios.launchStoryboard.file) : `${ios.launchStoryboard.name} (file not found)`) : "none" });
    lines.push({ ok: !!ios.pods, optional: true, label: "Podfile.lock", detail: ios.pods ? `${Object.keys(ios.pods).length} pods` : "missing" });
  }

  const android = project.android;
  if (android) {
    lines.push({ ok: true, label: "Gradle module", detail: rel(android.buildFile) });
    lines.push({ ok: !!android.applicationId?.value, label: "Application ID", detail: gradle(android.applicationId) });
    lines.push({ ok: !!(android.versionCode?.value && android.versionName?.value), label: "Android version", detail: `${gradle(android.versionName)} (${gradle(android.versionCode)})` });
    lines.push({ ok: !!android.targetSdk?.value, label: "SDK levels", detail: `target ${gradle(android.targetSdk)}, compile ${gradle(android.compileSdk)}, min ${gradle(android.minSdk)}` });
    const release = android.buildTypes.release;
    lines.push({ ok: true, optional: true, label: "Release signing", detail: release?.signingConfig ? release.signingConfig.raw : "no signingConfig in buildTypes.release" });
    lines.push({ ok: android.manifests.every((m) => !m.error), label: "Manifests", detail: android.manifests.map((m) => `${m.sourceSet}${m.error ? ` (unreadable: ${m.error})` : ""}`).join(", ") || "none" });
  }

  const ios_ = project.libraries.filter((l) => l.ios).length;
  const android_ = project.libraries.filter((l) => l.android).length;
  lines.push({ ok: true, label: "Native libraries", detail: `${project.libraries.length} (${ios_} iOS, ${android_} Android)` });
  for (const note of project.notes) lines.push({ ok: false, optional: true, label: "Note", detail: note });
  return lines;
}

export function doctorCommand(options: ReadOptions & { cwd: string; json?: boolean }) {
  let project: Project;
  try {
    project = readProject(options.cwd, options);
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    console.log(`${pc.red("✗")} ${pc.bold("Project".padEnd(18))} ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(project, null, 2));
    return;
  }
  const lines = describe(project);
  for (const line of lines) {
    const mark = line.ok ? pc.green("✓") : line.optional ? pc.yellow("!") : pc.red("✗");
    console.log(`${mark} ${pc.bold(line.label.padEnd(18))} ${line.detail}`);
  }
  if (lines.some((l) => !l.ok && !l.optional)) process.exitCode = 1;
}
