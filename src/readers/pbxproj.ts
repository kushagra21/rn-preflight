import { posix } from "node:path";

/** project.pbxproj is an old-style (OpenStep) property list: `{ key = value; }`, `( a, b, )`, strings. */
export type PbxValue = string | PbxValue[] | PbxDict;
export interface PbxDict {
  [key: string]: PbxValue;
}

const BARE = /[A-Za-z0-9_$/.:\-+<>]/;

export function parsePbxproj(text: string): PbxDict {
  let i = 0;
  const fail = (message: string): never => {
    const line = text.slice(0, i).split("\n").length;
    throw new Error(`project.pbxproj line ${line}: ${message}`);
  };

  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith("//", i)) {
        const end = text.indexOf("\n", i);
        i = end === -1 ? text.length : end + 1;
      } else if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) fail("unterminated comment");
        i = end + 2;
      } else {
        return;
      }
    }
  };

  const string = (): string => {
    skip();
    if (text[i] === '"') {
      i++;
      let out = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          i++;
          const c = text[i++];
          out += c === "n" ? "\n" : c === "t" ? "\t" : (c ?? "");
        } else {
          out += text[i++];
        }
      }
      if (text[i] !== '"') fail("unterminated string");
      i++;
      return out;
    }
    const start = i;
    while (i < text.length && BARE.test(text[i]!)) i++;
    if (i === start) fail(`unexpected ${JSON.stringify(text[i] ?? "end of file")}`);
    return text.slice(start, i);
  };

  const expect = (c: string) => {
    skip();
    if (text[i] !== c) fail(`expected ${JSON.stringify(c)}, found ${JSON.stringify(text[i] ?? "end of file")}`);
    i++;
  };

  const value = (): PbxValue => {
    skip();
    if (text[i] === "{") {
      i++;
      const dict: PbxDict = {};
      for (;;) {
        skip();
        if (text[i] === "}") {
          i++;
          return dict;
        }
        const key = string();
        expect("=");
        dict[key] = value();
        expect(";");
      }
    }
    if (text[i] === "(") {
      i++;
      const list: PbxValue[] = [];
      for (;;) {
        skip();
        if (text[i] === ")") {
          i++;
          return list;
        }
        list.push(value());
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== ")") fail("expected \",\" or \")\"");
      }
    }
    return string();
  };

  const root = value();
  if (typeof root !== "object" || Array.isArray(root)) fail("the top level isn't a dictionary");
  return root as PbxDict;
}

const asDict = (value: PbxValue | undefined): PbxDict | undefined =>
  typeof value === "object" && !Array.isArray(value) ? value : undefined;
const asList = (value: PbxValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export interface PbxTarget {
  id: string;
  name: string;
  productType: string;
  configurations: Record<string, Record<string, PbxValue>>;
  /** File names (as Xcode shows them) in the target's Copy Bundle Resources phase. */
  resources: string[];
  /** The same files' paths relative to the project's folder, where they can be worked out. */
  resourcePaths: string[];
  /**
   * Xcode 16 synchronized folders: every file under `path` (relative to the project's folder) belongs to the
   * target without being listed, except those in `exceptions` (relative to that folder).
   */
  syncedFolders: { path: string; exceptions: string[] }[];
}

export interface PbxProject {
  /** Project-level build settings by configuration name; targets inherit them. */
  configurations: Record<string, Record<string, PbxValue>>;
  targets: PbxTarget[];
}

/** The parts of a parsed project.pbxproj that rn-preflight needs. */
export function readPbxProject(text: string): PbxProject {
  const doc = parsePbxproj(text);
  const objects = asDict(doc.objects) ?? {};
  const object = (id: string) => asDict(objects[id]);

  const configurations = (listId: PbxValue | undefined) => {
    const out: Record<string, Record<string, PbxValue>> = {};
    const list = typeof listId === "string" ? object(listId) : undefined;
    for (const id of asList(list?.buildConfigurations)) {
      const config = object(id);
      if (typeof config?.name === "string") out[config.name] = asDict(config.buildSettings) ?? {};
    }
    return out;
  };

  const fileName = (buildFileId: string) => {
    const ref = object(buildFileId)?.fileRef;
    const file = typeof ref === "string" ? object(ref) : undefined;
    const name = file?.name ?? file?.path;
    return typeof name === "string" ? name.split("/").pop()! : undefined;
  };

  // A file's path is its own path inside each enclosing group's path (sourceTree "<group>").
  const parentOf = new Map<string, string>();
  for (const [id, value] of Object.entries(objects)) {
    const group = asDict(value);
    if (group && (group.isa === "PBXGroup" || group.isa === "PBXVariantGroup")) for (const child of asList(group.children)) parentOf.set(child, id);
  }
  const pathOf = (id: string, depth = 0): string | undefined => {
    const item = object(id);
    if (!item || depth > 50) return undefined;
    const own = typeof item.path === "string" ? item.path : "";
    if (item.sourceTree === "SOURCE_ROOT") return own;
    if (item.sourceTree === "<absolute>") return own;
    if (item.sourceTree !== "<group>") return undefined;
    const parent = parentOf.get(id);
    if (!parent) return own;
    const base = pathOf(parent, depth + 1);
    return base === undefined ? undefined : posix.join(base, own);
  };
  const filePath = (buildFileId: string) => {
    const ref = object(buildFileId)?.fileRef;
    return typeof ref === "string" ? pathOf(ref) : undefined;
  };

  const rootObject = typeof doc.rootObject === "string" ? object(doc.rootObject) : undefined;
  const targets: PbxTarget[] = asList(rootObject?.targets).flatMap((id) => {
    const target = object(id);
    if (target?.isa !== "PBXNativeTarget") return [];
    const resourceFiles = asList(target.buildPhases)
      .map(object)
      .filter((phase) => phase?.isa === "PBXResourcesBuildPhase")
      .flatMap((phase) => asList(phase!.files));
    const resources = resourceFiles.map(fileName).filter((name): name is string => !!name);
    const resourcePaths = resourceFiles.map(filePath).filter((path): path is string => !!path);
    const syncedFolders = asList(target.fileSystemSynchronizedGroups).flatMap((groupId) => {
      const group = object(groupId);
      if (typeof group?.path !== "string") return [];
      const exceptions = asList(group.exceptions)
        .map(object)
        .filter((set) => set?.target === id)
        .flatMap((set) => asList(set!.membershipExceptions));
      return [{ path: group.path, exceptions }];
    });
    return [{
      id,
      name: typeof target.name === "string" ? target.name : id,
      productType: typeof target.productType === "string" ? target.productType : "",
      configurations: configurations(target.buildConfigurationList),
      resources,
      resourcePaths,
      syncedFolders,
    }];
  });

  return { configurations: configurations(rootObject?.buildConfigurationList), targets };
}

/** Expands $(VAR) and ${VAR} from `settings`; unknown variables stay as they are. */
export function expandSettings(value: string, settings: Record<string, string>): string {
  return value.replace(/\$[({]([A-Za-z0-9_]+)(?::[^)}]*)?[)}]/g, (whole, name: string) => settings[name] ?? whole);
}
