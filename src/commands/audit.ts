import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import pc from "picocolors";
import { applyIgnores, CONFIG_FILE, loadConfig, saveIgnore, type IgnoredFinding, type IgnoreEntry } from "../core/config.js";
import { UserError } from "../core/errors.js";
import type { Platform } from "../core/types.js";
import { readPrevious } from "../readers/git.js";
import { readProject, type ReadOptions } from "../readers/project.js";
import { renderReport } from "../report/html.js";
import { applicableRules, RULES, runRules } from "../rules/index.js";
import type { Finding, Rule, Severity } from "../rules/types.js";

export type AuditOptions = ReadOptions & { cwd: string; since?: string; git?: boolean };

/** A finding as reported: paths relative to the app's root. */
export type ReportedFinding = Omit<Finding, "file"> & { file?: string };

export interface AuditResult {
  tool: "rn-preflight";
  version: string;
  generatedAt: string;
  app: {
    name?: string;
    reactNative: string;
    platforms: Platform[];
    ios?: { target: string; configuration: string; version: string };
    android?: { applicationId?: string; version: string };
    comparedWith?: string;
  };
  findings: ReportedFinding[];
  ignored: (ReportedFinding & { reason: string; date: string })[];
  /** Ignore entries that no longer match a finding. */
  stale: IgnoreEntry[];
  notes: string[];
  /** The rules that ran, without their check functions. */
  rules: Omit<Rule, "check">[];
  counts: Record<Severity, number>;
}

/** Reads the project, runs every rule that applies and applies preflight.config.json. */
export function runAudit(options: AuditOptions, version: string): AuditResult {
  const project = readProject(options.cwd, options);
  const config = loadConfig(project.root);
  if (options.git !== false) project.previous = readPrevious(project.root, options);
  const rules = applicableRules(project);
  const { active, ignored, stale } = applyIgnores(runRules(project, rules), config, new Set(rules.map((r) => r.id)));

  const rel = <T extends Finding | IgnoredFinding>(f: T) => ({ ...f, ...(f.file ? { file: relative(project.root, f.file) || "." } : {}) });
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of active) counts[f.severity]++;
  const ios = project.ios;
  const android = project.android;
  return {
    tool: "rn-preflight",
    version,
    generatedAt: new Date().toISOString(),
    app: {
      ...(project.name ? { name: project.name } : {}),
      reactNative: project.reactNative,
      platforms: (["ios", "android"] as const).filter((p) => project[p]),
      ...(ios ? { ios: { target: ios.target, configuration: ios.configuration, version: `${ios.version.marketing ?? "?"} (${ios.version.build ?? "?"})` } } : {}),
      ...(android ? { android: { ...(android.applicationId?.value ? { applicationId: android.applicationId.value } : {}), version: `${android.versionName?.value ?? "?"} (${android.versionCode?.value ?? "?"})` } } : {}),
      ...(project.previous?.ref ? { comparedWith: project.previous.ref } : {}),
    },
    findings: active.map(rel),
    ignored: ignored.map(rel),
    stale,
    notes: project.notes,
    rules: rules.map(({ check: _check, ...rule }) => rule),
    counts,
  };
}

const MARK: Record<Severity, string> = { error: pc.red("✗"), warning: pc.yellow("!"), info: pc.blue("i") };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function auditCommand(options: AuditOptions & { json?: boolean; html?: string }, version: string) {
  const result = runAudit(options, version);
  if (result.counts.error) process.exitCode = 1;

  if (options.html) {
    const out = resolve(options.cwd, options.html);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderReport(result));
    if (!options.json) console.log(pc.dim(`Report written to ${relative(process.cwd(), out) || out}`));
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const finding of result.findings) {
    const where = finding.file ? pc.dim(` ${finding.file}${finding.line ? `:${finding.line}` : ""}`) : "";
    console.log(`${MARK[finding.severity]} ${finding.message}${where} ${pc.dim(`[${finding.rule}]`)}`);
    if (finding.fix) console.log(`  ${pc.dim("→")} ${finding.fix}`);
  }
  for (const note of result.notes) console.log(pc.dim(`note: ${note}`));
  for (const entry of result.stale) console.log(pc.yellow(`${CONFIG_FILE} ignores ${entry.rule} ${entry.key}, which no longer happens; remove that entry.`));
  const { error, warning, info } = result.counts;
  const ignored = result.ignored.length ? `, ${result.ignored.length} ignored in ${CONFIG_FILE}` : "";
  console.log(`\n${plural(result.rules.length, "rule")}: ${plural(error, "error")}, ${plural(warning, "warning")}, ${info} info${ignored}`);
}

export function ignoreCommand(rule: string, key: string, options: AuditOptions & { reason?: string }, version: string) {
  if (!RULES.some((r) => r.id === rule)) throw new UserError(`There's no rule ${rule}. See rn-preflight rules.`);
  const reason = options.reason?.trim();
  if (!reason) throw new UserError('Say why with --reason "...", so the next person knows.');
  const result = runAudit(options, version);
  const all = [...result.findings, ...result.ignored];
  if (!all.some((f) => f.rule === rule && f.key === key)) {
    const keys = all.filter((f) => f.rule === rule).map((f) => f.key);
    throw new UserError(`${rule} has no finding with key ${key} in this app${keys.length ? ` (current keys: ${keys.join(", ")})` : ""}.`);
  }
  const root = resolve(options.cwd);
  const outcome = saveIgnore(root, { rule, key, reason, date: new Date().toISOString().slice(0, 10) });
  console.log(`${pc.green("✓")} ${outcome === "added" ? "Ignored" : "Updated the reason for"} ${rule} ${key} in ${CONFIG_FILE}`);
}

export function rulesCommand(options: { json?: boolean }) {
  if (options.json) {
    console.log(JSON.stringify(RULES.map(({ check: _check, ...rule }) => rule), null, 2));
    return;
  }
  for (const rule of RULES) console.log(`${MARK[rule.severity]} ${pc.bold(rule.id)} ${pc.dim(`(${rule.platform}, checked ${rule.checkedOn})`)}\n  ${rule.title}`);
}
