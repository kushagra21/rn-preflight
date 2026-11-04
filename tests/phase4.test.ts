import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ignoreCommand, runAudit } from "../src/commands/audit.js";
import { applyIgnores, loadConfig, parseConfig, saveIgnore } from "../src/core/config.js";
import { UserError } from "../src/core/errors.js";
import { readPrevious } from "../src/readers/git.js";
import { readProject } from "../src/readers/project.js";
import { renderReport } from "../src/report/html.js";
import { runRules } from "../src/rules/index.js";
import type { Finding, Rule } from "../src/rules/types.js";
import { compareDotted, versionBump, versionFormat, versionsMatch } from "../src/rules/versions.js";
import { fixture, makeDir, testAppFiles } from "./helpers.js";

const run = (rule: Rule, root: string, previous = false) => {
  const project = readProject(root);
  if (previous) project.previous = readPrevious(root, {});
  return runRules(project, [rule]).map((f) => `${f.severity} ${f.message}`);
};

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe" });
function repo(files = testAppFiles()) {
  const root = makeDir(files);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "release");
  git(root, "tag", "v1.0.0");
  return root;
}
const edit = (file: string, from: string | RegExp, to: string) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to));

describe("version-format and versions-match", () => {
  it("passes the template", () => {
    const root = makeDir(testAppFiles());
    expect(run(versionFormat, root)).toEqual([]);
    expect(run(versionsMatch, root)).toEqual([]);
  });

  it("rejects versions the stores don't accept", () => {
    const files = testAppFiles();
    files["ios/A11yTestApp.xcodeproj/project.pbxproj"] = fixture("testapp/project.pbxproj").replaceAll("MARKETING_VERSION = 1.0;", 'MARKETING_VERSION = "1.0.0-beta";');
    files["android/app/build.gradle"] = fixture("testapp/app.build.gradle").replace("versionCode 1", "versionCode 2100000001");
    const root = makeDir(files);
    expect(run(versionFormat, root)).toEqual([
      'error CFBundleShortVersionString is "1.0.0-beta"; App Store Connect accepts only up to three period-separated integers',
      "error versionCode is 2100000001; Google Play needs a whole number from 1 to 2100000000",
    ]);
    expect(run(versionsMatch, root)).toEqual(["warning iOS is 1.0.0-beta but Android is 1.0"]);
  });

  it("compares dotted versions numerically", () => {
    expect(compareDotted("1.10", "1.9")).toBe(1);
    expect(compareDotted("1.0", "1")).toBe(0);
    expect(compareDotted("2", "2.0.1")).toBe(-1);
  });
});

describe("version-bump", () => {
  it("flags build numbers not raised since the latest tag", () => {
    const root = repo();
    expect(run(versionBump, root, true)).toEqual([
      "warning iOS build 1 of 1.0 isn't higher than 1 at v1.0.0",
      "warning versionCode 1 isn't higher than 1 at v1.0.0",
    ]);
  });

  it("passes raised builds, lets a new version reset the build number, and flags a lower version", () => {
    const root = repo();
    edit(join(root, "android/app/build.gradle"), "versionCode 1", "versionCode 2");
    edit(join(root, "ios/A11yTestApp.xcodeproj/project.pbxproj"), /MARKETING_VERSION = 1\.0;/g, "MARKETING_VERSION = 1.1;");
    expect(run(versionBump, root, true)).toEqual([]);
    edit(join(root, "ios/A11yTestApp.xcodeproj/project.pbxproj"), /MARKETING_VERSION = 1\.1;/g, "MARKETING_VERSION = 0.9;");
    expect(run(versionBump, root, true)).toEqual(["warning iOS version 0.9 is lower than 1.0 at v1.0.0"]);
  });

  it("works when the app is in a subfolder of the repository, and leaves the working tree alone", () => {
    const files = Object.fromEntries(Object.entries(testAppFiles()).map(([k, v]) => [`apps/mobile/${k}`, v]));
    const top = repo(files);
    const root = join(top, "apps/mobile");
    expect(readPrevious(root, {})).toEqual({ ref: "v1.0.0", ios: { marketing: "1.0", build: "1" }, android: { versionName: "1.0", versionCode: "1" } });
    expect(git(top, "status", "--porcelain").toString()).toBe("");
  });

  it("explains why it can't compare, and refuses a bad --since", () => {
    expect(run(versionBump, makeDir(testAppFiles()), true)).toEqual(["info Version bumps not checked: not a git repository, so version bumps can't be checked"]);
    const untagged = repo();
    git(untagged, "tag", "-d", "v1.0.0");
    expect(run(versionBump, untagged, true)).toEqual(["info Version bumps not checked: no git tag to compare versions with; tag releases or pass --since <ref>"]);
    expect(() => readPrevious(untagged, { since: "nope" })).toThrow(UserError);
    expect(readPrevious(untagged, { since: "HEAD" }).ref).toBe("HEAD");
  });
});

describe("preflight.config.json", () => {
  const finding = (rule: string, key: string): Finding => ({ rule, key, severity: "warning", message: "m" });

  it("validates entries", () => {
    expect(parseConfig({ ignore: [{ rule: "r", key: "k", reason: "why" }] })).toEqual({ ignore: [{ rule: "r", key: "k", reason: "why", date: "" }] });
    expect(() => parseConfig({ ignored: [] })).toThrow(/unknown option ignored/);
    expect(() => parseConfig({ ignore: [{ rule: "r", key: "k" }] })).toThrow(/needs a reason/);
    expect(() => parseConfig({ ignore: {} })).toThrow(/should be a list/);
  });

  it("splits findings into active and ignored, and lists stale entries only for rules that ran", () => {
    const config = { ignore: [{ rule: "a", key: "1", reason: "fine", date: "2026-11-04" }, { rule: "b", key: "x", reason: "old", date: "" }, { rule: "c", key: "y", reason: "other platform", date: "" }] };
    const { active, ignored, stale } = applyIgnores([finding("a", "1"), finding("a", "2")], config, new Set(["a", "b"]));
    expect(active.map((f) => f.key)).toEqual(["2"]);
    expect(ignored).toEqual([{ ...finding("a", "1"), reason: "fine", date: "2026-11-04" }]);
    expect(stale.map((e) => e.rule)).toEqual(["b"]);
  });

  it("adds and updates entries, keeping the rest of the file", () => {
    const root = makeDir({ "preflight.config.json": { $schema: "x", ignore: [] } });
    expect(saveIgnore(root, { rule: "r", key: "k", reason: "one", date: "d" })).toBe("added");
    expect(saveIgnore(root, { rule: "r", key: "k", reason: "two", date: "d" })).toBe("updated");
    expect(JSON.parse(readFileSync(join(root, "preflight.config.json"), "utf8"))).toEqual({ $schema: "x", ignore: [{ rule: "r", key: "k", reason: "two", date: "d" }] });
    expect(loadConfig(root).ignore).toHaveLength(1);
  });
});

describe("ignore command and audit", () => {
  it("ignores a real finding, which audit then stops counting", () => {
    const root = makeDir(testAppFiles());
    const before = runAudit({ cwd: root, git: false }, "test");
    expect(before.findings.some((f) => f.rule === "android-release-signing")).toBe(true);
    ignoreCommand("android-release-signing", "debug", { cwd: root, git: false, reason: "CI signs it" }, "test");
    const after = runAudit({ cwd: root, git: false }, "test");
    expect(after.findings.some((f) => f.rule === "android-release-signing")).toBe(false);
    expect(after.ignored).toMatchObject([{ rule: "android-release-signing", key: "debug", reason: "CI signs it" }]);
    expect(after.counts.warning).toBe(before.counts.warning - 1);
  });

  it("refuses unknown rules, keys that don't match and a missing reason", () => {
    const root = makeDir(testAppFiles());
    expect(() => ignoreCommand("no-such-rule", "x", { cwd: root, git: false, reason: "r" }, "t")).toThrow(/no rule no-such-rule/);
    expect(() => ignoreCommand("android-release-signing", "nope", { cwd: root, git: false, reason: "r" }, "t")).toThrow(/current keys: debug/);
    expect(() => ignoreCommand("android-release-signing", "debug", { cwd: root, git: false, reason: " " }, "t")).toThrow(/--reason/);
  });

  it("reports paths relative to the app", () => {
    const result = runAudit({ cwd: makeDir(testAppFiles()), git: false }, "test");
    expect(result.findings.find((f) => f.rule === "android-release-signing")!.file).toBe("android/app/build.gradle");
  });
});

describe("HTML report", () => {
  const result = runAudit({ cwd: makeDir(testAppFiles()), git: false }, "test");

  it("pins its script and style by hash and loads nothing else", () => {
    const html = renderReport(result);
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src ${hash(script)}`);
    expect(csp).toContain(`style-src ${hash(style)}`);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<(link|img|iframe)\b/);
  });

  it("can't be broken out of by finding text", () => {
    const evil = { ...result, app: { ...result.app, name: '<img src=x onerror="alert(1)">' }, findings: [{ ...result.findings[0]!, message: "</script><script>alert(1)</script>" }] };
    const html = renderReport(evil);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html.match(/<script/g)).toHaveLength(2);
  });
});
