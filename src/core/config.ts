import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../rules/types.js";
import { UserError } from "./errors.js";
import { readText } from "./fs.js";

export const CONFIG_FILE = "preflight.config.json";

/** A finding the team decided to live with, and why. */
export interface IgnoreEntry {
  rule: string;
  key: string;
  reason: string;
  date: string;
}

export interface Config {
  ignore: IgnoreEntry[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new UserError(`${CONFIG_FILE} should hold a JSON object.`);
  const unknown = Object.keys(raw).filter((key) => key !== "ignore" && key !== "$schema");
  if (unknown.length) throw new UserError(`${CONFIG_FILE}: unknown option ${unknown.join(", ")}. Known: ignore.`);
  const list = raw.ignore ?? [];
  if (!Array.isArray(list)) throw new UserError(`${CONFIG_FILE}: ignore should be a list.`);
  const ignore = list.map((entry, i) => {
    const at = `${CONFIG_FILE}: ignore[${i}]`;
    if (!isObject(entry)) throw new UserError(`${at} should be an object with rule, key and reason.`);
    for (const field of ["rule", "key", "reason"] as const) {
      if (typeof entry[field] !== "string" || !(entry[field] as string).trim()) throw new UserError(`${at} needs a ${field}.`);
    }
    return { rule: entry.rule as string, key: entry.key as string, reason: entry.reason as string, date: typeof entry.date === "string" ? entry.date : "" };
  });
  return { ignore };
}

export function loadConfig(root: string): Config {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return { ignore: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readText(file));
  } catch (error) {
    throw new UserError(`${CONFIG_FILE} isn't valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(raw);
}

/** Adds or updates an ignore entry, keeping everything else in the file as it was. */
export function saveIgnore(root: string, entry: IgnoreEntry): "added" | "updated" {
  const file = join(root, CONFIG_FILE);
  const raw = existsSync(file) ? (JSON.parse(readText(file)) as Record<string, unknown>) : {};
  parseConfig(raw);
  const list = (raw.ignore ?? []) as IgnoreEntry[];
  const index = list.findIndex((e) => e.rule === entry.rule && e.key === entry.key);
  if (index === -1) list.push(entry);
  else list[index] = entry;
  raw.ignore = list;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return index === -1 ? "added" : "updated";
}

export interface IgnoredFinding extends Finding {
  reason: string;
  date: string;
}

/**
 * Splits findings into the ones that count and the ignored ones. `stale` entries are for rules that ran (`ran`) but
 * match nothing any more, so a platform left out with --platform doesn't make its entries look stale.
 */
export function applyIgnores(findings: Finding[], config: Config, ran?: Set<string>) {
  const matches = (e: IgnoreEntry, f: Finding) => e.rule === f.rule && e.key === f.key;
  const active: Finding[] = [];
  const ignored: IgnoredFinding[] = [];
  for (const finding of findings) {
    const entry = config.ignore.find((e) => matches(e, finding));
    if (entry) ignored.push({ ...finding, reason: entry.reason, date: entry.date });
    else active.push(finding);
  }
  const stale = config.ignore.filter((e) => (!ran || ran.has(e.rule)) && !findings.some((f) => matches(e, f)));
  return { active, ignored, stale };
}
