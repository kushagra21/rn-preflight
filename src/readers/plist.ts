import { XMLParser } from "fast-xml-parser";

export type PlistValue = string | number | boolean | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

type Node = Record<string, any>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  // The DOCTYPE in every plist is harmless; entities beyond the XML five aren't used.
  processEntities: true,
});

const tagOf = (node: Node) => Object.keys(node).find((key) => key !== "#text" && key !== ":@");
const textOf = (children: Node[]) => children.map((child) => child["#text"] ?? "").join("");
const elements = (children: Node[]) => children.filter((child) => tagOf(child) !== undefined);

function convert(node: Node): PlistValue {
  const tag = tagOf(node)!;
  const children: Node[] = node[tag] ?? [];
  switch (tag) {
    case "dict": {
      const dict: PlistDict = {};
      const items = elements(children);
      for (let i = 0; i + 1 < items.length; i += 2) {
        if (tagOf(items[i]!) !== "key") throw new Error(`expected <key> in <dict>, found <${tagOf(items[i]!)}>`);
        dict[textOf(items[i]!.key)] = convert(items[i + 1]!);
      }
      return dict;
    }
    case "array":
      return elements(children).map(convert);
    case "true":
      return true;
    case "false":
      return false;
    case "integer":
    case "real":
      return Number(textOf(children));
    case "string":
    case "date":
    case "data":
      return textOf(children);
    default:
      throw new Error(`unknown plist element <${tag}>`);
  }
}

/** Parses an XML property list. Binary plists aren't supported; Xcode keeps source plists as XML. */
export function parsePlist(xml: string): PlistValue {
  if (xml.startsWith("bplist")) throw new Error("binary plists aren't supported; convert with `plutil -convert xml1`");
  const root = (parser.parse(xml) as Node[]).find((node) => tagOf(node) === "plist");
  if (!root) throw new Error("no <plist> element");
  const value = elements(root.plist)[0];
  if (!value) throw new Error("empty <plist>");
  return convert(value);
}

export const isDict = (value: PlistValue | undefined): value is PlistDict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
