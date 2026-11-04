import { describe, expect, it } from "vitest";
import { expandSettings, parsePbxproj, readPbxProject } from "../src/readers/pbxproj.js";
import { parsePlist } from "../src/readers/plist.js";
import { fixture, plist } from "./helpers.js";

describe("parsePlist", () => {
  it("reads every value type, keeping strings that look like numbers as strings", () => {
    const value = parsePlist(
      plist(`<dict>
  <key>Version</key><string>1.0</string>
  <key>Empty</key><string></string>
  <key>Count</key><integer>3</integer>
  <key>On</key><true/>
  <key>Off</key><false/>
  <key>List</key><array><string>a</string><dict><key>b</key><real>1.5</real></dict></array>
  <key>Escaped</key><string>Scan &amp; save</string>
  <key>Spaced</key><string>  two words  </string>
</dict>`),
    );
    expect(value).toEqual({ Version: "1.0", Empty: "", Count: 3, On: true, Off: false, List: ["a", { b: 1.5 }], Escaped: "Scan & save", Spaced: "  two words  " });
  });

  it("reads the template's Info.plist", () => {
    const info = parsePlist(fixture("testapp/Info.plist")) as Record<string, any>;
    expect(info.CFBundleShortVersionString).toBe("$(MARKETING_VERSION)");
    expect(info.NSLocationWhenInUseUsageDescription).toBe("");
    expect(info.UISupportedInterfaceOrientations).toHaveLength(3);
  });

  it("refuses binary plists with a way out", () => {
    expect(() => parsePlist("bplist00…")).toThrow(/plutil/);
  });
});

describe("parsePbxproj", () => {
  it("reads quoted strings, bare words, lists and comments", () => {
    expect(
      parsePbxproj(`// !$*UTF8*$!
{ a = "x \\"y\\""; /* note */ b = (1, "$(inherited)", ); c = { d = some/path.plist; }; }`),
    ).toEqual({ a: 'x "y"', b: ["1", "$(inherited)"], c: { d: "some/path.plist" } });
  });

  it("says where it gave up", () => {
    expect(() => parsePbxproj("{\n a = ;\n}")).toThrow(/line 2/);
  });

  it("finds the template's app target, its Release settings and bundle resources", () => {
    const project = readPbxProject(fixture("testapp/project.pbxproj"));
    const app = project.targets.find((t) => t.productType === "com.apple.product-type.application")!;
    expect(app.name).toBe("A11yTestApp");
    expect(Object.keys(app.configurations).sort()).toEqual(["Debug", "Release"]);
    expect(app.configurations.Release!.MARKETING_VERSION).toBe("1.0");
    expect(app.configurations.Release!.INFOPLIST_FILE).toBe("A11yTestApp/Info.plist");
    expect(app.resources).toContain("PrivacyInfo.xcprivacy");
    expect(app.resources).toContain("LaunchScreen.storyboard");
    expect(app.resourcePaths).toContain("A11yTestApp/PrivacyInfo.xcprivacy");
    expect(project.configurations.Release).toBeDefined();
  });
});

describe("expandSettings", () => {
  it("expands $(X) and ${X}, drops modifiers and leaves unknowns", () => {
    const settings = { A: "one", B: "two" };
    expect(expandSettings("$(A)-${B}-$(A:rfc1034identifier)-$(C)", settings)).toBe("one-two-one-$(C)");
  });
});
