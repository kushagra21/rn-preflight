import type { Platform, Project } from "../core/types.js";

/** error: stores reject or block this. warning: likely to cause a rejection or a bad release. info: worth a look. */
export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  /** What to change, in one sentence. */
  fix?: string;
  /** Stable among runs (not a line number), so a baseline can ignore this finding. */
  key: string;
}

export type RawFinding = Omit<Finding, "rule" | "severity"> & { severity?: Severity };

export interface Rule {
  id: string;
  platform: Platform | "both";
  /** Default severity; a finding may lower or raise it. */
  severity: Severity;
  title: string;
  /** Why stores care, in a sentence or two, with the rejection code when there is one. */
  why: string;
  docs: string[];
  /** The date the rule was last checked against the stores' rules (YYYY-MM-DD). */
  checkedOn: string;
  check(project: Project): RawFinding[];
}

/** A table a rule depends on, with when and where it was last checked. */
export interface RuleData<T> {
  checkedOn: string;
  sources: string[];
  data: T;
}
