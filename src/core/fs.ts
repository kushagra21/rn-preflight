import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const readText = (file: string) => readFileSync(file, "utf8");
export const readJson = (file: string): Record<string, any> => JSON.parse(readText(file));
export const readIfExists = (file: string) => (existsSync(file) ? readText(file) : undefined);
export const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** The folder of a package as Node would find it from `fromDir`, walking up through node_modules. */
export function findPackageDir(fromDir: string, name: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

const SKIP_DIRS = new Set(["node_modules", "Pods", "build", ".git", "DerivedData", ".gradle"]);

/** Files under `dir` (not following node_modules, Pods or build output) whose name passes `match`. */
export function findFiles(dir: string, match: (name: string) => boolean, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path, depth + 1);
        // Bundles like Foo.xcassets are folders; let callers match them too.
        if (match(entry.name)) found.push(path);
      } else if (match(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(dir, 0);
  return found.sort();
}

/** The 1-based line of the first match of `pattern` in `file`, if any. */
export function lineOf(file: string, pattern: string | RegExp): number | undefined {
  const text = readIfExists(file);
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  const index = lines.findIndex((line) => (typeof pattern === "string" ? line.includes(pattern) : pattern.test(line)));
  return index === -1 ? undefined : index + 1;
}
