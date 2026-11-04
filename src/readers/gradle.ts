/**
 * Just enough of Groovy and Kotlin DSL build files to read the settings stores check. Gradle scripts are code,
 * so anything computed (if/else, functions, other files) is reported as unresolved instead of guessed.
 */

/** Replaces comments with spaces, leaving strings alone, so offsets and line numbers still match the file. */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const end = triple ? text.indexOf(c.repeat(3), i + 3) : findStringEnd(text, i, c);
      const stop = end === -1 ? text.length : end + (triple ? 3 : 1);
      out += text.slice(i, stop);
      i = stop;
    } else if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function findStringEnd(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i;
    else if (text[i] === "\n") return i - 1;
  }
  return -1;
}

export interface Block {
  /** Offset of the first character inside the braces, in the whole file. */
  start: number;
  body: string;
}

/** The index of the brace that closes the one at `open`. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = findStringEnd(text, i, c);
      if (end !== -1) i = end;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return text.length;
}

/** Top-level `name { ... }` blocks of `block`, in order: `[name, block]`. Handles create("x") and getByName("x"). */
export function childBlocks(block: Block): [string, Block][] {
  const out: [string, Block][] = [];
  const text = block.body;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = findStringEnd(text, i, c);
      if (end !== -1) i = end;
    } else if (c === "}") depth--;
    else if (c === "{") {
      if (depth === 0) {
        const head = /([A-Za-z_][\w.]*)(?:\s*\(\s*["']([^"']+)["']\s*\))?\s*$/.exec(text.slice(Math.max(0, i - 120), i));
        if (head) {
          const name = head[2] ?? head[1]!;
          const close = closingBrace(text, i);
          out.push([name, { start: block.start + i + 1, body: text.slice(i + 1, close) }]);
          i = close;
          continue;
        }
      }
      depth++;
    }
  }
  return out;
}

export const childBlock = (block: Block | undefined, name: string) =>
  block ? childBlocks(block).find(([n]) => n === name)?.[1] : undefined;

/** Statements at the top level of a block (nested blocks left out): `[key, expression, offset]`. */
export function assignments(block: Block): [string, string, number][] {
  const nested = childBlocks(block).map(([, b]) => [b.start - block.start, b.start - block.start + b.body.length] as const);
  const out: [string, string, number][] = [];
  const re = /^[ \t]*([A-Za-z_][\w.]*)\s*(?:=\s*|[ \t]+|(?=\())(.+?)\s*;?\s*$/gm;
  // `a = 1; b = 2` is two statements; a newline in place of each `;` keeps the offsets.
  const body = block.body.replace(/;/g, "\n");
  for (let m; (m = re.exec(body)); ) {
    if (nested.some(([from, to]) => m!.index >= from && m!.index < to)) continue;
    let value = m[2]!.trim();
    if (value.endsWith("{")) continue;
    // targetSdkVersion(34) and setVersionCode(3) style calls.
    const call = /^\((.*)\)$/.exec(value);
    if (call) value = call[1]!.trim();
    out.push([m[1]!, value, block.start + m.index]);
  }
  return out;
}

export const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

export interface Scope {
  /** ext { } values in the root build file, and ext.x = ... / extra["x"] = ... lines. */
  ext: Record<string, string>;
  /** gradle.properties */
  properties: Record<string, string>;
  /** def x = ... / val x = ... in the module's build file. */
  locals: Record<string, string>;
}

const literal = (expr: string): string | undefined => {
  const quoted = /^(["'])(.*)\1$/.exec(expr);
  if (quoted && !quoted[2]!.includes("${") && !(quoted[1] === '"' && quoted[2]!.includes("$"))) return quoted[2];
  if (/^-?\d+$/.test(expr) || expr === "true" || expr === "false") return expr;
  return undefined;
};

/** Resolves an expression to a literal value when it is one, or a reference to one; otherwise undefined. */
export function resolve(expr: string, scope: Scope, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  let e = expr.trim().replace(/\.(toInteger|toBoolean|toString|toInt)\(\)$/, "").replace(/\s+as\s+\w+$/, "");
  const lit = literal(e);
  if (lit !== undefined) return lit;
  const again = (next: string | undefined) => (next === undefined ? undefined : resolve(next, scope, depth + 1));

  let m;
  if ((m = /^(?:rootProject\.ext|project\.ext|rootProject|ext)\.(\w+)$/.exec(e))) return again(scope.ext[m[1]!]);
  if ((m = /^(?:rootProject\.ext|project\.ext|rootProject\.extra|extra)(?:\.get)?[(\[]\s*["'](\w+)["']\s*[)\]](?:\s+as\s+\w+)?$/.exec(e))) return again(scope.ext[m[1]!]);
  if ((m = /^(?:project\.)?(?:findProperty|property)\(\s*["']([\w.]+)["']\s*\)$/.exec(e))) return scope.properties[m[1]!];
  if ((m = /^(?:project\.)?properties\[\s*["']([\w.]+)["']\s*\]$/.exec(e))) return scope.properties[m[1]!];
  if (/^\w+$/.test(e)) return again(scope.locals[e]) ?? scope.properties[e];
  return undefined;
}

/** ext values from a root build file: `ext { a = 1 }` blocks (buildscript's too) and `ext.a = 1` lines. */
export function readExt(text: string): Record<string, string> {
  const clean = stripComments(text);
  const whole: Block = { start: 0, body: clean };
  const ext: Record<string, string> = {};
  const visit = (block: Block) => {
    for (const [name, child] of childBlocks(block)) {
      if (name === "ext") for (const [key, value] of assignments(child)) ext[key] = value;
      else visit(child);
    }
  };
  visit(whole);
  for (const m of clean.matchAll(/^\s*(?:rootProject\.)?ext(?:ra)?(?:\.(\w+)|\[\s*["'](\w+)["']\s*\])\s*=\s*(.+?)\s*$/gm)) ext[m[1] ?? m[2]!] = m[3]!;
  for (const m of clean.matchAll(/^\s*(?:rootProject\.)?ext(?:ra)?\.set\(\s*["'](\w+)["']\s*,\s*(.+?)\s*\)\s*$/gm)) ext[m[1]!] = m[2]!;
  return ext;
}

export function readLocals(text: string): Record<string, string> {
  const locals: Record<string, string> = {};
  for (const m of stripComments(text).matchAll(/^\s*(?:def|val|var)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*(.+?)\s*$/gm)) locals[m[1]!] = m[2]!;
  return locals;
}

export function readProperties(text: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (m) props[m[1]!] = m[2]!;
  }
  return props;
}
