// The configuration: everything the user writes by hand. Where the data is
// and which of its columns to use, the providers they have and how to prefer
// them, tags, jobs, and per-model tags, ID aliases and exclusions.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { dataModels, isEffort, loadData, normalizeId, parseWindowLength, type Data, type Effort } from "./data.ts";
import { parseRange } from "./request.ts";
import { parseToml, path, show, Validator, ValidationError, type Obj } from "./validate.ts";

export interface QuotaWindow {
  name: string;
  /** `<N>h`, `<N>d`, `daily`, `weekly` or `monthly`. */
  length: string;
  /** Model IDs the window is limited to; absent means every model. */
  models?: string[];
}

export interface Provider {
  name: string;
  /** The subscription, as free text for people. */
  plan?: string;
  quotaName?: string;
  /** Model IDs only for bounded work at this provider. */
  boundedOnly: string[];
  /** Routes of this provider costing more than this are for bounded work only. */
  boundedAboveCost?: number;
  /** How many heavy sessions may run at once on this provider. */
  maxHeavy: number;
  windowOverrides: QuotaWindow[];
}

export interface Policy {
  prefer: string[];
  preferMinSpare: number;
  spareStep: number;
  /** Routes costing at most this, with enough spare, rank ahead of the preferred providers. */
  cheapCost: number;
  /** Routes scoring at least this are heavy. */
  heavyScore: number;
}

export interface Columns {
  /** The data columns routing reads; each holds a number in every row. */
  use: string[];
  /** The column filtered by score ranges and compared with heavy_score. */
  score: string;
  /** The column compared with cheap_cost and bounded_above_cost, and ranked by. */
  cost: string;
}

export interface Job {
  name: string;
  /** The score range as written, `A-B` or `A+`. */
  score: string;
  min: number;
  max?: number;
  tags: string[];
  about: string;
}

export interface ModelEntry {
  /** The model ID, as in the data. */
  id: string;
  tags: string[];
  /** Provider to the model's exact ID there, when it doesn't match the data's. */
  ids: Record<string, string>;
}

export interface Exclusion {
  model: string;
  /** Absent: every effort of the model. */
  effort?: Effort;
  reason: string;
}

export interface Config {
  /** Absolute path of the data file. */
  data: string;
  columns: Columns;
  policy: Policy;
  /** The providers the user has, in the file's order. */
  providers: Record<string, Provider>;
  /** Tag to its meaning. */
  tags: Record<string, string>;
  jobs: Record<string, Job>;
  /** By normalized model ID. */
  models: Record<string, ModelEntry>;
  exclude: Exclusion[];
}

/** Every problem found in the configuration, one message each. */
export class ConfigError extends ValidationError {
  constructor(messages: string[]) {
    super(messages);
    this.name = "ConfigError";
  }
}

const fail = (messages: string[]): Error => new ConfigError(messages);

const TOP_KEYS = ["data", "columns", "policy", "providers", "tags", "jobs", "model", "exclude"];

/** `~/x` from the home directory, a relative path from `base`. */
export function resolvePath(value: string, base: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return resolve(base, value);
}

/**
 * Validates the text of a configuration file. `label` prefixes the messages,
 * and `file` is its path, which `data` is relative to.
 */
export function parseConfig(text: string, label: string, file: string, home = homedir()): Config {
  const root = parseToml(text, label, fail) as Obj;
  const v = new Validator(label);
  v.keys(root, TOP_KEYS, "");

  const dataPath = v.nonEmptyString(root, "data", "");

  // Tags first: the rest refers to them.
  const tags: Record<string, string> = {};
  if (root.tags !== undefined) {
    const table = v.table(root.tags, "tags");
    for (const [key, value] of Object.entries(table ?? {})) {
      if (typeof value !== "string" || value.trim() === "") v.error(`tags.${key}`, "must be a non-empty string");
      else tags[key] = value;
    }
  }
  const knownTags = (list: string[] | undefined, where: string): string[] => {
    (list ?? []).forEach((tag, i) => {
      if (!(tag in tags)) v.error(`${where}[${i}]`, `unknown tag ${show(tag)}; define it in [tags]`);
    });
    return list ?? [];
  };

  const columns: Columns = { use: [], score: "", cost: "" };
  if (root.columns === undefined) v.error("", 'missing "columns"');
  else {
    const table = v.table(root.columns, "columns");
    if (table) {
      v.keys(table, ["use", "score", "cost"], "columns");
      const use = v.strings(table, "use", "columns") ?? [];
      if (table.use !== undefined && use.length === 0) v.error("columns.use", "must not be empty");
      const seen = new Set<string>();
      use.forEach((name, i) => {
        if (["model", "vendor", "effort", "date"].includes(name)) v.error(`columns.use[${i}]`, `${show(name)} is not a numeric column`);
        else if (seen.has(name)) v.error(`columns.use[${i}]`, `duplicate column ${show(name)}`);
        seen.add(name);
      });
      columns.use = use;
      for (const role of ["score", "cost"] as const) {
        const name = v.nonEmptyString(table, role, "columns");
        if (name !== undefined && !use.includes(name)) v.error(`columns.${role}`, `${show(name)} is not in columns.use`);
        columns[role] = name ?? "";
      }
    }
  }

  const providerTables: Record<string, Obj> = {};
  if (root.providers === undefined) v.error("", 'missing "providers"');
  else {
    const table = v.table(root.providers, "providers");
    if (table) {
      if (Object.keys(table).length === 0) v.error("providers", "must not be empty");
      for (const [key, value] of Object.entries(table)) {
        const entry = v.table(value, `providers.${key}`);
        if (entry) providerTables[key] = entry;
      }
    }
  }
  const providerNames = Object.keys(providerTables);

  const providers: Record<string, Provider> = {};
  for (const [name, table] of Object.entries(providerTables)) {
    const where = `providers.${name}`;
    v.keys(table, ["plan", "quota_name", "bounded_only", "bounded_above_cost", "max_heavy", "window_overrides"], where);
    const plan = table.plan === undefined ? undefined : v.nonEmptyString(table, "plan", where);
    const quotaName = v.string(table, "quota_name", where, false);
    const boundedOnly = v.strings(table, "bounded_only", where, false) ?? [];
    const boundedAboveCost =
      table.bounded_above_cost === undefined ? undefined : v.number(table, "bounded_above_cost", where, "non-negative");
    const maxHeavy = v.number(table, "max_heavy", where, "positive");
    if (maxHeavy !== undefined && !Number.isInteger(maxHeavy)) {
      v.error(path(where, "max_heavy"), `must be an integer, got ${maxHeavy}`);
    }
    const windows: QuotaWindow[] = [];
    for (const [i, window] of (v.tables(table, "window_overrides", where, false) ?? []).entries()) {
      const at = `${path(where, "window_overrides")}[${i}]`;
      v.keys(window, ["name", "length", "models"], at);
      const windowName = v.nonEmptyString(window, "name", at);
      const length = v.string(window, "length", at);
      if (length !== undefined && parseWindowLength(length) === undefined) {
        v.error(`${at}.length`, `unknown window length ${show(length)}`);
      }
      const windowModels = v.strings(window, "models", at, false);
      if (windowName !== undefined && length !== undefined) {
        windows.push({ name: windowName, length, ...(windowModels ? { models: windowModels } : {}) });
      }
    }
    providers[name] = {
      name,
      ...(plan !== undefined ? { plan } : {}),
      ...(quotaName !== undefined ? { quotaName } : {}),
      boundedOnly,
      ...(boundedAboveCost !== undefined ? { boundedAboveCost } : {}),
      maxHeavy: maxHeavy ?? 1,
      windowOverrides: windows,
    };
  }

  const policy: Policy = { prefer: [], preferMinSpare: 0, spareStep: 1, cheapCost: 0, heavyScore: 0 };
  if (root.policy === undefined) v.error("", 'missing "policy"');
  else {
    const table = v.table(root.policy, "policy");
    if (table) {
      v.keys(table, ["prefer", "prefer_min_spare", "spare_step", "cheap_cost", "heavy_score"], "policy");
      const prefer = v.strings(table, "prefer", "policy");
      prefer?.forEach((provider, i) => {
        if (!providerNames.includes(provider)) v.error(`policy.prefer[${i}]`, `provider ${show(provider)} is not in providers`);
      });
      policy.prefer = prefer ?? [];
      policy.preferMinSpare = v.number(table, "prefer_min_spare", "policy") ?? 0;
      policy.spareStep = v.number(table, "spare_step", "policy", "positive") ?? 1;
      policy.cheapCost = v.number(table, "cheap_cost", "policy", "non-negative") ?? 0;
      policy.heavyScore = v.number(table, "heavy_score", "policy", "non-negative") ?? 0;
    }
  }

  const jobs: Record<string, Job> = {};
  if (root.jobs !== undefined) {
    const table = v.table(root.jobs, "jobs");
    for (const [name, value] of Object.entries(table ?? {})) {
      const where = `jobs.${name}`;
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) v.error(where, "a job name is lowercase letters, digits, - and _, starting with a letter");
      const entry = v.table(value, where);
      if (!entry) continue;
      v.keys(entry, ["score", "tags", "about"], where);
      const score = v.string(entry, "score", where);
      let range: { min: number; max?: number } | undefined;
      if (score !== undefined) {
        try {
          range = parseRange(score);
        } catch (error) {
          v.error(`${where}.score`, error instanceof Error ? error.message : String(error));
        }
      }
      const jobTags = knownTags(v.strings(entry, "tags", where, false), `${where}.tags`);
      const about = v.nonEmptyString(entry, "about", where);
      if (score !== undefined && range && about !== undefined) {
        jobs[name] = { name, score, ...range, tags: jobTags, about };
      }
    }
  }

  const models: Record<string, ModelEntry> = {};
  for (const [i, entry] of (v.tables(root, "model", "", false) ?? []).entries()) {
    const where = `model[${i}]`;
    v.keys(entry, ["id", "tags", "ids"], where);
    const id = v.nonEmptyString(entry, "id", where);
    const modelTags = knownTags(v.strings(entry, "tags", where, false), `${where}.tags`);
    const ids: Record<string, string> = {};
    if (entry.ids !== undefined) {
      const table = v.table(entry.ids, `${where}.ids`);
      for (const [provider, value] of Object.entries(table ?? {})) {
        if (typeof value !== "string" || value.trim() === "") v.error(`${where}.ids.${provider}`, "must be a non-empty string");
        else if (!providerNames.includes(provider)) v.error(`${where}.ids.${provider}`, `provider ${show(provider)} is not in providers`);
        else ids[provider] = value;
      }
    }
    if (id === undefined) continue;
    const key = normalizeId(id);
    if (models[key]) v.error(where, `model ${show(id)} is already listed`);
    else models[key] = { id, tags: modelTags, ids };
  }

  const exclude: Exclusion[] = [];
  for (const [i, entry] of (v.tables(root, "exclude", "", false) ?? []).entries()) {
    const where = `exclude[${i}]`;
    v.keys(entry, ["model", "effort", "reason"], where);
    const model = v.nonEmptyString(entry, "model", where);
    const effort = v.string(entry, "effort", where, false);
    const reason = v.nonEmptyString(entry, "reason", where);
    if (effort !== undefined && !isEffort(effort)) v.error(`${where}.effort`, `unknown effort ${show(effort)}`);
    if (model !== undefined && reason !== undefined && (effort === undefined || isEffort(effort))) {
      exclude.push({ model, ...(effort !== undefined ? { effort: effort as Effort } : {}), reason });
    }
  }

  if (v.errors.length > 0) throw new ConfigError(v.errors);
  return {
    data: resolvePath(dataPath!, dirname(resolve(file)), home),
    columns,
    policy,
    providers,
    tags,
    jobs,
    models,
    exclude,
  };
}

/**
 * The configuration's model references that the data doesn't have: `[[model]]`,
 * `exclude` (and its effort), `bounded_only` and `window_overrides`.
 */
export function checkAgainstData(config: Config, data: Data, label: string): string[] {
  const known = dataModels(data);
  const efforts = new Map<string, Set<Effort>>();
  for (const row of data.rows) {
    const key = normalizeId(row.model);
    if (!efforts.has(key)) efforts.set(key, new Set());
    efforts.get(key)!.add(row.effort);
  }
  const problems: string[] = [];
  const check = (id: string, where: string): boolean => {
    if (known.has(normalizeId(id))) return true;
    problems.push(`${label}: ${where}: model ${show(id)} is not in the data`);
    return false;
  };
  Object.values(config.models).forEach((entry, i) => check(entry.id, `model[${i}].id`));
  config.exclude.forEach((entry, i) => {
    if (!check(entry.model, `exclude[${i}].model`) || entry.effort === undefined) return;
    if (!efforts.get(normalizeId(entry.model))!.has(entry.effort)) {
      problems.push(`${label}: exclude[${i}].effort: ${show(entry.effort)} is not an effort of model ${show(entry.model)} in the data`);
    }
  });
  for (const provider of Object.values(config.providers)) {
    const where = `providers.${provider.name}`;
    provider.boundedOnly.forEach((id, i) => check(id, `${where}.bounded_only[${i}]`));
    provider.windowOverrides.forEach((window, i) =>
      window.models?.forEach((id, j) => check(id, `${where}.window_overrides[${i}].models[${j}]`)),
    );
  }
  return problems;
}

/** How the configuration file was found. */
export type ConfigSource = "--config" | "MODEL_ROUTING_CONFIG" | "default";

export interface ConfigFile {
  path: string;
  source: ConfigSource;
}

/** The example files that ship with the repository. */
export const EXAMPLE_DIR = join(import.meta.dir, "..", "examples");

/** Where the configuration is: `--config`, else `$MODEL_ROUTING_CONFIG`, else the default path. The first found wins. */
export function locateConfig(flag: string | undefined, env: Record<string, string | undefined> = process.env): ConfigFile {
  if (flag !== undefined) return { path: flag, source: "--config" };
  const fromEnv = env.MODEL_ROUTING_CONFIG;
  if (fromEnv !== undefined && fromEnv !== "") return { path: fromEnv, source: "MODEL_ROUTING_CONFIG" };
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return { path: resolve(base, "opencode", "model-routing", "config.toml"), source: "default" };
}

/** `from --config`, `from $MODEL_ROUTING_CONFIG` or `default path`. */
export function describeSource(source: ConfigSource): string {
  if (source === "--config") return "from --config";
  if (source === "MODEL_ROUTING_CONFIG") return "from $MODEL_ROUTING_CONFIG";
  return "default path";
}

/**
 * Reads the configuration file. An explicit path that can't be read is an
 * error naming it; a missing default file says how to create one.
 */
export function readConfigText(file: ConfigFile): string {
  try {
    return readFileSync(file.path, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    if (missing && file.source === "default") {
      throw new ConfigError([
        `no configuration at ${file.path}; start from ${join(EXAMPLE_DIR, "config.toml")}, and point its "data" at your data file`,
      ]);
    }
    const via = file.source === "default" ? "" : ` (${describeSource(file.source)})`;
    throw new ConfigError([`${file.path}: cannot read: ${missing ? "no such file" : String(error)}${via}`]);
  }
}

/** Reads and validates the configuration file. */
export function loadConfig(file: ConfigFile, home = homedir()): Config {
  return parseConfig(readConfigText(file), file.path, file.path, home);
}

/** The configuration and its data, validated together. */
export interface Routing {
  config: Config;
  data: Data;
}

/**
 * Loads the configuration and the data it points at, or `dataPath` instead,
 * and validates them together.
 */
export function loadRouting(file: ConfigFile, dataPath?: string): Routing {
  const config = loadConfig(file);
  if (dataPath !== undefined) config.data = resolve(dataPath);
  const data = loadData(config.data, config.columns.use);
  const problems = checkAgainstData(config, data, file.path);
  if (problems.length > 0) throw new ConfigError(problems);
  return { config, data };
}
