import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import pc from "picocolors";
import { auditCommand, ignoreCommand, rulesCommand } from "./commands/audit.js";
import { CONFIG_FILE } from "./core/config.js";
import { doctorCommand } from "./commands/doctor.js";
import { UserError } from "./core/errors.js";
import type { Platform } from "./core/types.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** Options every command that reads the project takes. */
function projectOptions(command: Command): Command {
  return command
    .option("-C, --cwd <dir>", "the app's root folder", process.cwd())
    .addOption(new Option("-p, --platform <platform>", "which platform to check").choices(["ios", "android", "both"]).default("both"))
    .option("--xcodeproj <path>", "the Xcode project, when ios/ has several")
    .option("--target <name>", "the app target (default: the one named like the project)")
    .option("--configuration <name>", "the build configuration to check", "Release")
    .option("--android-module <name>", "the Gradle app module (default: app)");
}

const readOptions = (options: { cwd: string } & Record<string, any>) => ({
  ...options,
  module: options.androidModule,
  platforms: (options.platform === "both" ? ["ios", "android"] : [options.platform]) as Platform[],
});

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("rn-preflight")
    .description("Check a bare React Native app for App Store and Google Play rejection risks before you build and upload.")
    .version(version);

  projectOptions(program.command("audit").description("Check the app; exits with 1 when there are errors"))
    .option("--json", "print the findings as JSON")
    .option("--html <file>", "also write an HTML report, e.g. preflight-report.html")
    .option("--since <ref>", "the release to compare version numbers with (default: the latest git tag)")
    .option("--no-git", "don't compare version numbers with git")
    .action((options) => auditCommand(readOptions(options), version));

  projectOptions(
    program
      .command("ignore")
      .description(`Accept a finding: saves it with your reason in ${CONFIG_FILE}, so audit stops counting it`)
      .argument("<rule>", "the rule id, e.g. android-release-signing")
      .argument("<key>", "the finding's key, shown in --json output and the report"),
  )
    .requiredOption("--reason <text>", "why it's fine, for the next person")
    .option("--since <ref>", "as for audit")
    .option("--no-git", "as for audit")
    .action((rule, key, options) => ignoreCommand(rule, key, readOptions(options), version));

  program
    .command("rules")
    .description("List the checks, with the date each was last checked against the stores' rules")
    .option("--json", "print them as JSON")
    .action(rulesCommand);

  projectOptions(program.command("doctor").description("Show what rn-preflight found in the project: targets, files, versions"))
    .option("--json", "print everything it read as JSON")
    .action((options) => doctorCommand(readOptions(options)));

  return program;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  buildProgram()
    .parseAsync()
    .catch((error: unknown) => {
      console.error(pc.red(error instanceof UserError ? error.message : String((error as Error)?.stack ?? error)));
      process.exitCode = 2;
    });
}
