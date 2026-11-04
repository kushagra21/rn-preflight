import type { Project } from "../core/types.js";
import { cleartextTraffic, debuggable, launcherIcon, releaseSigning, sensitivePermissions, targetSdk } from "./android.js";
import { appIcon, encryptionFlag, ipadOrientations, launchScreen, loginServices, sceneLifecycle, transportSecurity } from "./ios-app.js";
import { privacyManifestPresent, privacyPodApis, privacyReasons, privacySdkList } from "./ios-privacy.js";
import { usageStringMissing, usageStringQuality, usageStringTranslations } from "./ios-usage.js";
import type { Finding, Rule, Severity } from "./types.js";

/** Every rule rn-preflight runs, in the order `rules` lists them. */
export const RULES: Rule[] = [
  usageStringMissing,
  usageStringQuality,
  usageStringTranslations,
  privacyManifestPresent,
  privacyReasons,
  privacyPodApis,
  privacySdkList,
  appIcon,
  launchScreen,
  ipadOrientations,
  sceneLifecycle,
  transportSecurity,
  encryptionFlag,
  loginServices,
  targetSdk,
  sensitivePermissions,
  releaseSigning,
  debuggable,
  cleartextTraffic,
  launcherIcon,
];

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Runs the rules that apply to the platforms the project was read for; a rule that throws becomes a finding. */
export function runRules(project: Project, rules: Rule[] = RULES): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (rule.platform !== "both" && !project[rule.platform]) continue;
    try {
      for (const raw of rule.check(project)) findings.push({ ...raw, rule: rule.id, severity: raw.severity ?? rule.severity });
    } catch (error) {
      findings.push({ rule: rule.id, severity: "warning", key: "crashed", message: `This check failed to run: ${(error as Error).message}. Please report it.` });
    }
  }
  return findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.rule.localeCompare(b.rule));
}
