import { relative } from "node:path";
import pc from "picocolors";
import { readProject, type ReadOptions } from "../readers/project.js";
import { RULES, runRules } from "../rules/index.js";
import type { Severity } from "../rules/types.js";

const MARK: Record<Severity, string> = { error: pc.red("✗"), warning: pc.yellow("!"), info: pc.blue("i") };

export function auditCommand(options: ReadOptions & { cwd: string; json?: boolean }, version: string) {
  const project = readProject(options.cwd, options);
  const findings = runRules(project);
  const errors = findings.filter((f) => f.severity === "error").length;
  if (errors) process.exitCode = 1;

  if (options.json) {
    console.log(JSON.stringify({ tool: "rn-preflight", version, root: project.root, notes: project.notes, findings }, null, 2));
    return;
  }
  for (const finding of findings) {
    const where = finding.file ? pc.dim(` ${relative(project.root, finding.file)}${finding.line ? `:${finding.line}` : ""}`) : "";
    console.log(`${MARK[finding.severity]} ${finding.message}${where} ${pc.dim(`[${finding.rule}]`)}`);
    if (finding.fix) console.log(`  ${pc.dim("→")} ${finding.fix}`);
  }
  for (const note of project.notes) console.log(pc.dim(`note: ${note}`));
  const warnings = findings.filter((f) => f.severity === "warning").length;
  console.log(`\n${RULES.length} rules, ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${findings.length - errors - warnings} info`);
}

export function rulesCommand(options: { json?: boolean }) {
  if (options.json) {
    console.log(JSON.stringify(RULES.map(({ check: _check, ...rule }) => rule), null, 2));
    return;
  }
  if (!RULES.length) console.log("No rules yet.");
  for (const rule of RULES) console.log(`${MARK[rule.severity]} ${pc.bold(rule.id)} ${pc.dim(`(${rule.platform}, checked ${rule.checkedOn})`)}\n  ${rule.title}`);
}
