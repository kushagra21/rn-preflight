import type { Project } from "../core/types.js";
import type { Finding, Rule, Severity } from "./types.js";

/** Every rule rn-preflight runs. Phases 2 and 3 fill this in. */
export const RULES: Rule[] = [];

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
