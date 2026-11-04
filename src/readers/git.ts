import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../core/errors.js";
import type { PreviousVersions } from "../core/types.js";
import { readAndroid } from "./android.js";
import { readIos, type IosOptions } from "./ios.js";

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });

/**
 * The app's versions at `since`, or at the latest tag reachable from HEAD: the last release, if tags mark
 * releases. Reads ios/ and android/ from git into a temporary folder; never touches the working tree.
 */
export function readPrevious(root: string, options: IosOptions & { since?: string; module?: string }): PreviousVersions {
  let prefix: string;
  let top: string;
  try {
    prefix = git(root, ["rev-parse", "--show-prefix"]).toString().trim();
    top = git(root, ["rev-parse", "--show-toplevel"]).toString().trim();
  } catch {
    return { note: "not a git repository, so version bumps can't be checked" };
  }
  let ref = options.since;
  if (!ref) {
    try {
      ref = git(root, ["describe", "--tags", "--abbrev=0"]).toString().trim();
    } catch {
      return { note: "no git tag to compare versions with; tag releases or pass --since <ref>" };
    }
  }
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch {
    if (options.since) throw new UserError(`--since ${ref} isn't a commit, tag or branch in this repository.`);
    return { note: `${ref} isn't a commit` };
  }

  const dir = mkdtempSync(join(tmpdir(), "rn-preflight-previous-"));
  try {
    const previous: PreviousVersions = { ref };
    const notes: string[] = [];
    for (const folder of ["ios", "android"] as const) {
      let archive: Buffer;
      try {
        // From a subfolder, git archive would also filter the tree by that subfolder, so run it at the top.
        archive = git(top, ["archive", "--format=tar", `${ref}:${prefix}${folder}`]);
      } catch {
        continue;
      }
      const target = join(dir, folder);
      mkdirSync(target, { recursive: true });
      execFileSync("tar", ["-x", "-C", target], { input: archive, stdio: ["pipe", "ignore", "ignore"] });
      try {
        if (folder === "ios") {
          const ios = readIos(target, options, notes);
          previous.ios = ios.version;
        } else {
          const android = readAndroid(target, options, notes);
          previous.android = { ...(android.versionName?.value ? { versionName: android.versionName.value } : {}), ...(android.versionCode?.value ? { versionCode: android.versionCode.value } : {}) };
        }
      } catch {
        // The project layout changed since then; nothing to compare on that platform.
      }
    }
    return previous;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
