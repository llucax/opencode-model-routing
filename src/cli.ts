// The model-route command line: reads the configuration, its data, the
// provider catalog and the quota, asks the core for routes and prints them.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CatalogError, defaultModelsJsonPath, loadModelsJson } from "./catalog.ts";
import { checkConfigDir, checkRoutes } from "./check.ts";
import { buildRouting, loadConfig, loadRouting, locateConfig, type Routing } from "./config.ts";
import { dataModels, parseData, readDataText, type Data } from "./data.ts";
import { compile, ExprError, type ExprType } from "./expr.ts";
import type { Located } from "./formulas.ts";
import { formatConfig, formatText, jsonConfig, jsonReport } from "./format.ts";
import { loadQuota } from "./quota.ts";
import { buildRequest, NEEDS, splitList, UsageError } from "./request.ts";
import { route } from "./route.ts";
import { ValidationError } from "./validate.ts";

const USAGE = `Usage: model-route [options]
       model-route check [--config FILE] [--models-json FILE] [--config-dir DIR]
       model-route check --data FILE
       model-route config [--json] [--config FILE] [--data FILE]

Ranks the provider/model/effort routes that fit a request, using the data
the configuration points at, what each provider offers and the quota left at
each provider.

Options:
  --job NAME          a job from the configuration: its score range and tags
  --score RANGE       A-B for a score range, A+ for at least A; replaces the job's
  --tags a,b          prefer models with these tags (soft: others rank lower);
                      replaces the job's, even when empty
  --need CAPABILITY   require a capability: ${NEEDS.join(", ")}; repeat or use commas
  --not-model X       avoid a model, by its data ID or provider/ID, and prefer
                      other vendors; repeat or use commas
  --limit N           how many routes to print, 0 for all (default: 1 with --job
                      or --score, else all)
  --value EXPR        rank by this formula, or a formula's name, instead of the
                      job's or formulas.value
  --where EXPR        only routes this predicate holds for, instead of the job's
  --json              print one JSON object instead of text
  --config FILE       configuration (default: $MODEL_ROUTING_CONFIG, else
                      \${XDG_CONFIG_HOME:-$HOME/.config}/opencode/model-routing/config.toml)
  --data FILE         data file, instead of the configuration's
  --models-json FILE  provider catalog (default: ~/.cache/opencode/models.json)
  --quota-json FILE   saved \`opencode-quota show --json\` output
                      (default: run the opencode-quota CLI)
  --now ISO           the time to compute the quota spare at (default: now)
  --config-dir DIR    check only: the OpenCode directory with the agents and skills
  -h, --help          show this help

The configuration is the first found of --config, $MODEL_ROUTING_CONFIG and
\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/model-routing/config.toml, with no
merging. Start from examples/config.toml in the repository.

model-route config prints the files in use and the effective configuration;
--json prints them as JSON.

model-route check validates the configuration and its data, reports data
models none of the configured providers offer, and checks model mentions,
--score ranges and jobs in AGENTS.md, agents/*.md, skills/*/SKILL.md and
tool-instructions/*.md under the config directory (default:
~/.config/opencode). With --data alone it only validates that data file:
its format, and a number in every row of every column but model, vendor,
effort and date. It prints one problem per line and exits 1 if there are any.

Exit status: 0 with routes, 2 when nothing matches, 1 on errors. For check: 0
when clean, 1 with problems. For config: 0, or 1 on errors.
`;

export interface Options {
  job?: string;
  score?: string;
  tags?: string[];
  need?: string[];
  "not-model"?: string[];
  limit?: string;
  value?: string;
  where?: string;
  json?: boolean;
  data?: string;
  config?: string;
  "models-json"?: string;
  "quota-json"?: string;
  now?: string;
  help?: boolean;
  "config-dir"?: string;
}

function parseNow(text: string | undefined): Date {
  if (text === undefined) return new Date();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new UsageError(`invalid --now "${text}": use an ISO 8601 time`);
  return date;
}

function parseLimit(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new UsageError(`invalid --limit "${text}": use a positive integer, or 0 for every route`);
  return Number(text);
}

/** Options that only make sense when routing. */
const ROUTING_ONLY = ["job", "score", "tags", "need", "not-model", "limit", "value", "where", "json", "quota-json", "now"] as const;

/** `--value` or `--where`, compiled; a problem is a usage error naming the option and the column. */
function option(name: "value" | "where", text: string | undefined, type: ExprType): Located | undefined {
  if (text === undefined) return undefined;
  try {
    return { key: `--${name}`, expr: compile(text, type) };
  } catch (error) {
    if (error instanceof ExprError) throw new UsageError(`--${name}: column ${error.column}: ${error.message}`);
    throw error;
  }
}

function reject(options: Options, names: readonly (keyof Options)[], command: string): void {
  for (const name of names) {
    if (options[name] !== undefined) throw new UsageError(`--${name} does not apply to ${command}; see --help`);
  }
}

function print(problems: string[]): void {
  process.stdout.write(problems.map((problem) => `${problem}\n`).join(""));
}

/** `check --data FILE`: the data file alone. */
function runDataCheck(path: string): number {
  let data: Data;
  try {
    data = parseData(readDataText(path), path);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    print(error.messages);
    return 1;
  }
  const models = dataModels(data).size;
  process.stdout.write(`OK: ${data.rows.length} rows of ${models} models, ${data.columns.length} columns\n`);
  return 0;
}

/** The `check` command: prints the problems found, or one OK line, and returns the exit status. */
function runCheck(options: Options): number {
  reject(options, ROUTING_ONLY, "check");
  if (options.data !== undefined) {
    reject(options, ["config", "models-json", "config-dir"], "check --data");
    return runDataCheck(options.data);
  }
  const file = locateConfig(options.config);
  const problems: string[] = [];
  let routing: Routing;
  try {
    const config = loadConfig(file);
    routing = buildRouting(config, readDataText(config.data), file.path, config.data);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    print(error.messages);
    return 1;
  }
  const { data } = routing;

  const catalog = loadModelsJson(options["models-json"] ?? defaultModelsJsonPath());
  problems.push(...checkRoutes(routing, catalog, file.path));

  const configDir = options["config-dir"] ?? join(homedir(), ".config", "opencode");
  let files = 0;
  if (!existsSync(configDir)) problems.push(`${configDir}: no such configuration directory`);
  else {
    const checked = checkConfigDir(configDir, routing, catalog);
    problems.push(...checked.problems);
    files = checked.files;
  }

  if (problems.length > 0) {
    print(problems);
    return 1;
  }
  const models = dataModels(data).size;
  process.stdout.write(`OK: ${data.rows.length} rows of ${models} models and ${files} configuration files checked\n`);
  return 0;
}

/** The `config` command: prints the files in use and the effective configuration. */
function runConfig(options: Options): number {
  reject(options, [...ROUTING_ONLY.filter((name) => name !== "json"), "models-json", "config-dir"], "config");
  const file = locateConfig(options.config);
  const routing = loadRouting(file, options.data);
  const sources = { config: { ...file, path: resolve(file.path) } };
  process.stdout.write(options.json ? `${JSON.stringify(jsonConfig(sources, routing), null, 2)}\n` : formatConfig(sources, routing));
  return 0;
}

/** The `route` command: prints the result and returns the exit status. */
async function runRoute(options: Options): Promise<number> {
  const now = parseNow(options.now);
  // Compiled before loading, so the data's columns they use are read too.
  const value = option("value", options.value, "number");
  const where = option("where", options.where, "truth");
  const routing = loadRouting(locateConfig(options.config), options.data, [value, where].filter((entry) => entry !== undefined));
  const request = buildRequest(
    {
      ...(options.job !== undefined ? { job: options.job } : {}),
      ...(options.score !== undefined ? { score: options.score } : {}),
      ...(options.tags !== undefined ? { tags: splitList(options.tags) } : {}),
      needs: splitList(options.need),
      notModels: splitList(options["not-model"]),
      ...(options.limit !== undefined ? { limit: parseLimit(options.limit)! } : {}),
      ...(value ? { value: value.expr } : {}),
      ...(where ? { where: where.expr } : {}),
    },
    routing.config,
    options.job !== undefined || options.score !== undefined ? 1 : 0,
  );

  const catalog = loadModelsJson(options["models-json"] ?? defaultModelsJsonPath());
  const quota = await loadQuota(routing.config, now, options["quota-json"]);
  const warnings = [...quota.warnings];
  const result = route(request, { routing, catalog, quota });
  warnings.push(...result.warnings);

  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(jsonReport(result, request, quota, routing, warnings), null, 2)}\n`);
  } else {
    process.stdout.write(formatText(result, request, quota, routing));
  }
  return result.routes.length > 0 || result.aboveRange.length > 0 ? 0 : 2;
}

/** Runs the command line and returns the exit status. */
export async function main(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        job: { type: "string" },
        score: { type: "string" },
        tags: { type: "string", multiple: true },
        need: { type: "string", multiple: true },
        "not-model": { type: "string", multiple: true },
        limit: { type: "string" },
        value: { type: "string" },
        where: { type: "string" },
        json: { type: "boolean" },
        data: { type: "string" },
        config: { type: "string" },
        "models-json": { type: "string" },
        "quota-json": { type: "string" },
        now: { type: "string" },
        "config-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const options = values as Options;
    if (options.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const [command, ...extra] = positionals;
    if (command !== undefined && command !== "check" && command !== "config") throw new UsageError(`unexpected argument "${command}"; see --help`);
    if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"; see --help`);
    if (command === "check") return runCheck(options);
    if (command === "config") return runConfig(options);
    if (options["config-dir"] !== undefined) throw new UsageError("--config-dir only applies to check; see --help");
    return await runRoute(options);
  } catch (error) {
    if (error instanceof ValidationError) {
      for (const message of error.messages) process.stderr.write(`model-route: ${message}\n`);
    } else if (error instanceof UsageError || error instanceof CatalogError) {
      for (const line of error.message.split("\n")) process.stderr.write(`${line.startsWith("  ") ? "" : "model-route: "}${line}\n`);
    } else if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`model-route: ${error.message}; see --help\n`);
    } else {
      process.stderr.write(`model-route: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
