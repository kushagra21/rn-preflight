import { describe, expect, it } from "vitest";
import { assignments, childBlock, childBlocks, readExt, readLocals, readProperties, resolve, stripComments, type Block } from "../src/readers/gradle.js";

const whole = (text: string): Block => ({ start: 0, body: stripComments(text) });

describe("stripComments", () => {
  it("removes comments but not // inside strings, and keeps line numbers", () => {
    const text = `a = "https://x" // gone\n/* multi\nline */ b = 1`;
    const out = stripComments(text);
    expect(out).toContain('"https://x"');
    expect(out).not.toContain("gone");
    expect(out.split("\n")).toHaveLength(3);
    expect(out.length).toBe(text.length);
  });
});

describe("blocks and assignments", () => {
  const groovy = whole(`
android {
    compileSdk 36
    defaultConfig {
        versionCode 12
        versionName "1.4.0"
        targetSdkVersion(35)
    }
    signingConfigs {
        release { storeFile file("release.keystore") }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}`);

  it("finds nested blocks", () => {
    const android = childBlock(groovy, "android")!;
    expect(childBlocks(android).map(([name]) => name)).toEqual(["defaultConfig", "signingConfigs", "buildTypes"]);
    expect(assignments(childBlock(android, "defaultConfig")!).map(([k, v]) => [k, v])).toEqual([
      ["versionCode", "12"],
      ["versionName", '"1.4.0"'],
      ["targetSdkVersion", "35"],
    ]);
  });

  it("keeps a block's own statements apart from its children's", () => {
    expect(assignments(childBlock(groovy, "android")!).map(([k]) => k)).toEqual(["compileSdk"]);
  });

  it("reads Kotlin DSL create(\"x\") and getByName(\"x\") blocks", () => {
    const kts = whole(`android {
  signingConfigs { create("upload") { storeFile = file("u.jks") } }
  buildTypes { getByName("release") { isMinifyEnabled = true } }
}`);
    const android = childBlock(kts, "android")!;
    expect(childBlocks(childBlock(android, "signingConfigs")!).map(([n]) => n)).toEqual(["upload"]);
    expect(assignments(childBlock(childBlock(android, "buildTypes")!, "release")!).map(([k, v]) => [k, v])).toEqual([["isMinifyEnabled", "true"]]);
  });
});

describe("resolve", () => {
  const scope = {
    ext: { targetSdkVersion: "36", alias: "rootProject.ext.targetSdkVersion", name: '"2.0"' },
    properties: { VERSION_CODE: "41", "app.flag": "true" },
    locals: { enableProguard: "false", code: "project.properties['VERSION_CODE'].toInteger()" },
  };

  it.each([
    ["36", "36"],
    ['"1.2.3"', "1.2.3"],
    ["'1.2.3'", "1.2.3"],
    ["rootProject.ext.targetSdkVersion", "36"],
    ['rootProject.ext.get("targetSdkVersion")', "36"],
    ['rootProject.extra["targetSdkVersion"] as Int', "36"],
    ["rootProject.ext.alias", "36"],
    ["rootProject.ext.name", "2.0"],
    ['findProperty("VERSION_CODE")', "41"],
    ["project.properties['VERSION_CODE']", "41"],
    ["enableProguard", "false"],
    ["code", "41"],
    ["VERSION_CODE", "41"],
  ])("%s → %s", (expr, value) => {
    expect(resolve(expr, scope)).toBe(value);
  });

  it.each(['"${major}.${minor}"', "getVersionCode()", "isCi ? 1 : 2", "rootProject.ext.missing"])("leaves %s unresolved", (expr) => {
    expect(resolve(expr, scope)).toBeUndefined();
  });
});

describe("ext, locals and properties", () => {
  it("reads ext blocks inside buildscript and ext lines", () => {
    expect(readExt(`buildscript { ext { targetSdkVersion = 36\n minSdkVersion = 24 } }\next.compileSdk = 36\nextra["kts"] = 1`)).toEqual({
      targetSdkVersion: "36",
      minSdkVersion: "24",
      compileSdk: "36",
      kts: "1",
    });
  });

  it("reads def and val", () => {
    expect(readLocals("def a = false\nval b: Int = 3\n")).toEqual({ a: "false", b: "3" });
  });

  it("reads gradle.properties and skips comments", () => {
    expect(readProperties("# c\n! c\na=1\nb : two words\n")).toEqual({ a: "1", b: "two words" });
  });
});
