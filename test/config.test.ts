import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, EXAMPLE_DIR, checkAgainstData, describeSource, loadConfig, loadRouting, locateConfig, parseConfig, readConfigText, resolvePath } from "../src/config.ts";
import { editedConfig, fixtureConfig, fixtureConfigText, fixtureData, fixtureText, tempDir, writeFiles } from "./helpers.ts";

const parse = (text = fixtureConfigText, file = fixtureConfig) => parseConfig(text, "config.toml", file, "/home/tester");
function errors(text: string): string[] {
  try { parse(text); }
  catch (error) { if (error instanceof ConfigError) return error.messages; throw error; }
  throw new Error("expected ConfigError");
}

describe("config and data", () => {
  test("loads the config and its relative CSV, with roles, jobs, tags, aliases and providers", () => {
    const { config, data } = loadRouting({ path: fixtureConfig, source: "--config" });
    expect(config.data).toBe(join(import.meta.dir, "fixtures", "models.csv"));
    expect(config.columns).toEqual({ use: ["score", "cost"], score: "score", cost: "cost" });
    expect(config.jobs.implement).toMatchObject({ name: "implement", min: 40, max: 47, tags: ["code"] });
    expect(config.tags.vision).toBe("images.");
    expect(config.models["acme big"]?.ids).toEqual({ anthropic: "acme-big", "github-copilot": "acme-big.1" });
    expect(config.providers["github-copilot"]).toMatchObject({ quotaName: "copilot", boundedOnly: ["Acme Big"], maxHeavy: 1 });
    expect(data.rows).toHaveLength(8);
    expect(checkAgainstData(config, data, "config.toml")).toEqual([]);
  });
  test("absolute, relative and tilde data paths", () => {
    expect(resolvePath("~/models.csv", "/base", "/home/tester")).toBe("/home/tester/models.csv");
    expect(resolvePath("../models.csv", "/base/config")).toBe("/base/models.csv");
    expect(parse(editedConfig('data = "models.csv"', 'data = "~/models.csv"')).data).toBe("/home/tester/models.csv");
    const dir = writeFiles(tempDir(), { "config.toml": fixtureConfigText, "override.csv": fixtureText });
    expect(loadRouting({ path: join(dir, "config.toml"), source: "--config" }, join(dir, "override.csv")).data.rows).toHaveLength(8);
  });
  test("exclusions for a whole model and one effort, with reasons", () => {
    const text = `${fixtureConfigText}\n[[exclude]]\nmodel = "Zed Pro"\nreason = "obsolete"\n[[exclude]]\nmodel = "Acme Small"\neffort = "high"\nreason = "slow"\n`;
    expect(parse(text).exclude).toEqual([{ model: "Zed Pro", reason: "obsolete" }, { model: "Acme Small", effort: "high", reason: "slow" }]);
    expect(checkAgainstData(parse(text), fixtureData().data, "config.toml")).toEqual([]);
  });
  test("a config may parse but reference models or efforts absent from data", () => {
    const text = editedConfig('bounded_only = ["Acme Big"]', 'bounded_only = ["Ghost"]') + '\n[[exclude]]\nmodel = "Zed Pro"\neffort = "none"\nreason = "x"\n[[exclude]]\nmodel = "Nobody"\nreason = "x"\n[[model]]\nid = "Missing"\n';
    expect(checkAgainstData(parse(text), fixtureData().data, "config.toml")).toEqual([
      'config.toml: model[5].id: model "Missing" is not in the data',
      'config.toml: exclude[0].effort: "none" is not an effort of model "Zed Pro" in the data',
      'config.toml: exclude[1].model: model "Nobody" is not in the data',
      'config.toml: providers.github-copilot.bounded_only[0]: model "Ghost" is not in the data',
    ]);
  });
  test("window model references are checked against the data", () => {
    const changed = parse(editedConfig('models = ["Acme Big"]', 'models = ["Ghost"]'));
    expect(checkAgainstData(changed, fixtureData().data, "config.toml")).toEqual([
      'config.toml: providers.anthropic.window_overrides[0].models[0]: model "Ghost" is not in the data',
    ]);
  });
  test("plan and bounded_above_cost are optional per provider", () => {
    const text = editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nplan = "Plus"\nmax_heavy = 1\nbounded_above_cost = 0.5');
    expect(parse(text).providers.openai).toMatchObject({ plan: "Plus", boundedAboveCost: 0.5 });
    expect(parse().providers.openai).toMatchObject({ maxHeavy: 1, boundedOnly: [], windowOverrides: [] });
  });
  test("without loading data, unknown model references and unoffered providers can parse", () => {
    const text = editedConfig('bounded_only = ["Acme Big"]', 'bounded_only = ["Nobody"]')
      .replace("[providers.openai]", "[providers.nowhere]\nmax_heavy = 1\n\n[providers.openai]");
    expect(parse(text).providers.nowhere).toBeDefined();
  });
  test("the example config and data validate together if present", () => {
    const example = join(EXAMPLE_DIR, "config.toml");
    if (!existsSync(example) || !existsSync(join(EXAMPLE_DIR, "models.csv"))) return;
    expect(() => loadRouting({ path: example, source: "--config" })).not.toThrow();
  });
});

describe("configuration validation", () => {
  test("required sections and columns roles", () => {
    expect(errors("")).toEqual(['config.toml: missing "data"', 'config.toml: missing "columns"', 'config.toml: missing "providers"', 'config.toml: missing "policy"']);
    expect(errors(editedConfig('use = ["score", "cost"]', 'use = ["score", "score", "date"]'))).toContain('config.toml: columns.use[1]: duplicate column "score"');
    expect(errors(editedConfig('use = ["score", "cost"]', 'use = ["score", "score", "date"]'))).toContain('config.toml: columns.use[2]: "date" is not a numeric column');
    expect(errors(editedConfig('cost = "cost"', 'cost = "missing"'))).toEqual(['config.toml: columns.cost: "missing" is not in columns.use']);
    expect(errors(editedConfig('use = ["score", "cost"]', 'use = []'))).toContain('config.toml: columns.use: must not be empty');
  });
  test("unknown tags and job names, ranges, and required descriptions", () => {
    expect(errors(editedConfig('tags = ["code"]', 'tags = ["unknown"]'))).toEqual(['config.toml: jobs.implement.tags[0]: unknown tag "unknown"; define it in [tags]']);
    expect(errors(editedConfig('score = "40-47"', 'score = "60-40"'))).toContain('config.toml: jobs.implement.score: invalid score range "60-40": the lower bound is above the upper bound');
    expect(errors(editedConfig('[jobs.implement]', '[jobs.Bad]'))).toContain('config.toml: jobs.Bad: a job name is lowercase letters, digits, - and _, starting with a letter');
    expect(errors(editedConfig('about = "Implement a defined task"', 'about = " "'))).toContain('config.toml: jobs.implement.about: must not be empty');
    expect(errors(editedConfig('tags = ["plan", "code", "review"]', 'tags = ["bad"]'))).toContain('config.toml: model[0].tags[0]: unknown tag "bad"; define it in [tags]');
  });
  test("duplicate normalized model, invalid alias provider, exclusion effort and reason", () => {
    expect(errors(`${fixtureConfigText}\n[[model]]\nid = "acme big"\n`)).toContain('config.toml: model[5]: model "acme big" is already listed');
    expect(errors(editedConfig('anthropic = "acme-big"', 'unknown = "acme-big"'))).toContain('config.toml: model[0].ids.unknown: provider "unknown" is not in providers');
    expect(errors(`${fixtureConfigText}\n[[exclude]]\nmodel = "Zed Pro"\neffort = "bad"\nreason = "x"\n`)).toContain('config.toml: exclude[0].effort: unknown effort "bad"');
    expect(errors(`${fixtureConfigText}\n[[exclude]]\nmodel = "Zed Pro"\nreason = " "\n`)).toContain('config.toml: exclude[0].reason: must not be empty');
  });
  test("provider and policy constraints and unrecognized keys", () => {
    expect(errors(editedConfig('max_heavy = 2', 'max_heavy = 1.5'))).toContain('config.toml: providers.anthropic.max_heavy: must be an integer, got 1.5');
    expect(errors(editedConfig('length = "monthly"', 'length = "fortnightly"'))).toContain('config.toml: providers.github-copilot.window_overrides[0].length: unknown window length "fortnightly"');
    expect(errors(editedConfig('prefer = ["anthropic", "openai", "github-copilot"]', 'prefer = ["ghost"]'))).toContain('config.toml: policy.prefer[0]: provider "ghost" is not in providers');
    expect(errors(`extra = 1\n${fixtureConfigText}`)).toEqual(['config.toml: unknown key "extra"']);
  });
  test("policy numbers must have the required type and range", () => {
    const cases = [
      ["cheap_cost = 0.15", 'cheap_cost = "low"', "must be a number"],
      ["cheap_cost = 0.15", "cheap_cost = -1", "must not be negative, got -1"],
      ["heavy_score = 55", "heavy_score = true", "must be a number"],
      ["spare_step = 10", "spare_step = 0", "must be positive, got 0"],
      ["prefer_min_spare = -10", 'prefer_min_spare = "low"', "must be a number"],
    ];
    for (const [before, after, message] of cases) expect(errors(editedConfig(before!, after!)).some((error) => error.endsWith(message!))).toBe(true);
  });
  test("provider max_heavy, bounded cost and plan validate independently", () => {
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", "[providers.openai]\nmax_heavy = 0"))).toContain(
      "config.toml: providers.openai.max_heavy: must be positive, got 0",
    );
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nmax_heavy = 1\nbounded_above_cost = "x"'))).toContain(
      "config.toml: providers.openai.bounded_above_cost: must be a number",
    );
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", "[providers.openai]\nmax_heavy = 1\nplan = 3"))).toContain(
      "config.toml: providers.openai.plan: must be a string",
    );
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nmax_heavy = 1\nplan = " "'))).toContain(
      "config.toml: providers.openai.plan: must not be empty",
    );
  });
  test("missing required policy and provider keys are diagnosed", () => {
    expect(errors(editedConfig("cheap_cost = 0.15\n", ""))).toContain('config.toml: policy: missing "cheap_cost"');
    expect(errors(editedConfig("heavy_score = 55\n", ""))).toContain('config.toml: policy: missing "heavy_score"');
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", "[providers.openai]"))).toContain('config.toml: providers.openai: missing "max_heavy"');
  });
  test("an empty providers table is invalid, and several issues are collected", () => {
    expect(errors('data = "x"\n[columns]\nuse = ["score", "cost"]\nscore = "score"\ncost = "cost"\n[providers]\n[policy]\nprefer = []\nprefer_min_spare = 0\nspare_step = 1\ncheap_cost = 0\nheavy_score = 0\n')).toContain("config.toml: providers: must not be empty");
    const problems = errors(editedConfig("spare_step = 10", "spare_step = -1").replace("heavy_score = 55", "heavy_score = -3")
      .replace("[providers.openai]\nmax_heavy = 1", "[providers.openai]\nmax_heavy = 0"));
    expect(problems).toHaveLength(3);
  });
  test("unknown keys inside policy, provider and window are reported", () => {
    const changed = editedConfig("spare_step = 10", "spare_step = 10\nwhat = 1")
      .replace('quota_name = "copilot"', 'quota_name = "copilot"\nlimit = 3')
      .replace('length = "monthly" }', 'length = "monthly", extra = true }');
    expect(errors(changed)).toEqual([
      'config.toml: providers.github-copilot: unknown key "limit"',
      'config.toml: providers.github-copilot.window_overrides[0]: unknown key "extra"',
      'config.toml: policy: unknown key "what"',
    ]);
  });
  test("syntax errors include a line", () => {
    expect(errors('[policy]\n\nfoo = = 1\n')[0]).toMatch(/^config\.toml: TOML syntax error at line 3:/);
  });
});

describe("configuration lookup and reading", () => {
  const env = { HOME: "/home/someone" };
  test("explicit, environment and default path priority", () => {
    expect(locateConfig("a.toml", { ...env, MODEL_ROUTING_CONFIG: "b.toml" })).toEqual({ path: "a.toml", source: "--config" });
    expect(locateConfig(undefined, { ...env, MODEL_ROUTING_CONFIG: "b.toml" }).source).toBe("MODEL_ROUTING_CONFIG");
    expect(locateConfig(undefined, { ...env, XDG_CONFIG_HOME: "/xdg" }).path).toBe("/xdg/opencode/model-routing/config.toml");
    expect(locateConfig(undefined, env).path).toBe("/home/someone/.config/opencode/model-routing/config.toml");
    expect([describeSource("--config"), describeSource("MODEL_ROUTING_CONFIG"), describeSource("default")]).toEqual([
      "from --config", "from $MODEL_ROUTING_CONFIG", "default path",
    ]);
  });
  test("explicit file, missing default file and valid load", () => {
    expect(loadConfig({ path: fixtureConfig, source: "--config" }).providers.openai).toBeDefined();
    expect(() => readConfigText({ path: "/nonexistent/config.toml", source: "--config" })).toThrow(ConfigError);
    try { readConfigText({ path: "/nonexistent/config.toml", source: "default" }); }
    catch (error) { expect((error as ConfigError).messages[0]).toContain("start from"); }
  });
  test("environment-specified missing config says which source was used", () => {
    for (const source of ["--config", "MODEL_ROUTING_CONFIG"] as const) {
      try { readConfigText({ path: "/nonexistent/config.toml", source }); throw new Error("expected ConfigError"); }
      catch (error) { expect((error as ConfigError).messages[0]).toContain(describeSource(source)); }
    }
  });
  test("a path pointing to a directory fails with an underlying read error", () => {
    try { readConfigText({ path: tempDir(), source: "default" }); throw new Error("expected ConfigError"); }
    catch (error) { expect((error as ConfigError).messages[0]).toMatch(/cannot read: .*EISDIR/); }
  });
});
