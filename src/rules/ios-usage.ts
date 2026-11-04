import usage from "../data/usage-strings.json" with { type: "json" };
import { lineOf } from "../core/fs.js";
import type { IosProject } from "../core/types.js";
import { infoKeyLocation, list } from "./helpers.js";
import type { RawFinding, Rule, RuleData } from "./types.js";

type LibraryKeys = { required?: string[]; ifUsed?: Record<string, string> };
const DATA = usage as RuleData<{ libraries: Record<string, LibraryKeys>; permissionHandlers: Record<string, string[]> }>;

const DOCS_5_1_1 = "https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage";
const DOCS_KEYS = "https://developer.apple.com/documentation/bundleresources/information-property-list/protected-resources";

/** A purpose string key, as Info.plist keys go (NSLocationTemporaryUsageDescriptionDictionary is a dictionary). */
const isUsageKey = (key: string) => /UsageDescription$/.test(key) || key === "NFCReaderUsageDescription";

/** Keys the app's native dependencies need: key → who needs it, and whether only for some features. */
export function neededKeys(project: { libraries: { name: string; ios: boolean }[] }, ios: IosProject) {
  const needed = new Map<string, { by: string[]; condition?: string }>();
  const add = (key: string, by: string, condition?: string) => {
    const entry = needed.get(key);
    if (!entry) needed.set(key, { by: [by], ...(condition ? { condition } : {}) });
    else {
      entry.by.push(by);
      // Any library that always needs it makes it required.
      if (!condition) delete entry.condition;
    }
  };
  for (const library of project.libraries) {
    const keys = DATA.data.libraries[library.name];
    if (!keys || !library.ios) continue;
    for (const key of keys.required ?? []) add(key, library.name);
    for (const [key, condition] of Object.entries(keys.ifUsed ?? {})) add(key, library.name, condition);
  }
  for (const handler of ios.podfilePermissions ?? []) {
    for (const key of DATA.data.permissionHandlers[handler] ?? []) add(key, `react-native-permissions (${handler})`);
  }
  return needed;
}

export const usageStringMissing: Rule = {
  id: "ios-usage-string-missing",
  platform: "ios",
  severity: "error",
  title: "Purpose strings your native libraries need are in Info.plist",
  why: "App Store Connect rejects a build that links an API needing a purpose string without one (ITMS-90683), and the app crashes when it asks for the permission.",
  docs: [DOCS_KEYS],
  checkedOn: DATA.checkedOn,
  check(project) {
    const ios = project.ios!;
    if (!ios.infoPlist) return [];
    const findings: RawFinding[] = [];
    for (const [key, { by, condition }] of neededKeys(project, ios)) {
      if (key in ios.infoPlist.values) continue;
      findings.push({
        key,
        ...(condition ? { severity: "warning" as const } : {}),
        message: condition ? `${key} is missing; ${list(by)} need${by.length === 1 ? "s" : ""} it ${condition}` : `${key} is missing; ${list(by)} need${by.length === 1 ? "s" : ""} it`,
        file: ios.infoPlist.file,
        fix: `Add ${key} to Info.plist with a sentence saying what the app does with it.`,
      });
    }
    return findings;
  },
};

const PLACEHOLDER = /\[REASON\]|\bTODO\b|\bFIXME\b|lorem ipsum|^\s*(test|description|usage description|reason)\s*\.?\s*$/i;
const GENERIC = /^((this|the|our) app|we|\$\(PRODUCT_NAME\)|[\w ]{1,30}) (needs|requires|wants|would like|uses|is requesting|will request)( to)? (access|permission)( to)?( (use|access))?( (your|the))? [\w ]{1,20}\.?$/i;

/** "App needs camera access", "We require location permission". */
const GENERIC_NOUN = /^[\w$() ]{0,30}\b(needs|requires|wants|would like|uses|require|need)( to (use|access))? (your |the )?[\w ]{1,20} (access|permission|permissions)\.?$/i;

/** Why a purpose string would likely fail review, if it would. */
export function purposeProblem(value: string): { severity: "error" | "warning"; reason: string } | undefined {
  const text = value.trim();
  if (!text) return { severity: "error", reason: "is empty" };
  if (PLACEHOLDER.test(text)) return { severity: "error", reason: `is a placeholder ("${text}")` };
  if (GENERIC.test(text) || GENERIC_NOUN.test(text) || text.split(/\s+/).length < 4) {
    return { severity: "warning", reason: `says what but not why ("${text}"); App Review asks for how the app uses the data` };
  }
  return undefined;
}

export const usageStringQuality: Rule = {
  id: "ios-usage-string-quality",
  platform: "ios",
  severity: "warning",
  title: "Purpose strings say why the app needs the permission",
  why: "Guideline 5.1.1(ii): App Review rejects purpose strings that are empty, placeholders, or don't explain how the app uses the data.",
  docs: [DOCS_5_1_1],
  checkedOn: "2026-11-04",
  check(project) {
    const ios = project.ios!;
    const needed = neededKeys(project, ios);
    const findings: RawFinding[] = [];
    for (const [key, value] of Object.entries(ios.infoPlist?.values ?? {})) {
      if (!isUsageKey(key) || typeof value !== "string") continue;
      const problem = purposeProblem(value);
      if (!problem) continue;
      // The RN template adds NSLocationWhenInUseUsageDescription empty. When nothing we know of uses the key, it's
      // more likely a leftover than a broken prompt, and removing it is the fix.
      const leftover = problem.severity === "error" && !needed.has(key);
      findings.push({
        key,
        severity: leftover ? "warning" : problem.severity,
        message: leftover ? `${key} ${problem.reason}, and no native library here asks for it` : `${key} ${problem.reason}`,
        ...infoKeyLocation(ios, key),
        fix: leftover
          ? "Remove the key if the app doesn't use this permission (the React Native template adds an empty location string); otherwise write why the app needs it."
          : 'Write what the feature does with it, e.g. "Your camera is used to scan receipts so you don\'t have to type them."',
      });
    }
    for (const strings of ios.infoPlistStrings ?? []) {
      for (const [key, value] of Object.entries(strings.values)) {
        if (!isUsageKey(key)) continue;
        const problem = purposeProblem(value);
        if (problem) findings.push({ key: `${strings.language}:${key}`, severity: problem.severity, message: `${key} (${strings.language}) ${problem.reason}`, file: strings.file, line: lineOf(strings.file, key) });
      }
    }
    return findings;
  },
};

export const usageStringTranslations: Rule = {
  id: "ios-usage-string-translations",
  platform: "ios",
  severity: "info",
  title: "Translated purpose strings cover every permission",
  why: "When a language translates some purpose strings, a missing one shows in the development language in an otherwise translated permission prompt.",
  docs: ["https://developer.apple.com/documentation/bundleresources/information-property-list/protected-resources"],
  checkedOn: "2026-11-04",
  check(project) {
    const ios = project.ios!;
    const keys = Object.entries(ios.infoPlist?.values ?? {}).filter(([key, value]) => isUsageKey(key) && typeof value === "string" && value.trim()).map(([key]) => key);
    return (ios.infoPlistStrings ?? []).flatMap((strings) => {
      // A file that only renames the app (or is empty) isn't translating permissions at all.
      if (!Object.keys(strings.values).some(isUsageKey)) return [];
      const missing = keys.filter((key) => !(key in strings.values));
      if (!missing.length) return [];
      return [{ key: strings.language, message: `${strings.language}.lproj/InfoPlist.strings doesn't translate ${list(missing)}`, file: strings.file }];
    });
  },
};
