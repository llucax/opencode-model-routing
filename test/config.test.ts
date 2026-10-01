import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, EXAMPLE_DIR, buildRouting, checkAgainstData, describeSource, heavyOf, loadConfig, loadRouting, locateConfig, parseConfig, readConfigText, resolvePath } from "../src/config.ts";
import { DataError } from "../src/data.ts";
import { compile } from "../src/expr.ts";
import { usedColumns } from "../src/formulas.ts";
import { edited, editedConfig, fixtureConfig, fixtureConfigText, fixtureData, fixtureText, routing, tempDir, writeFiles } from "./helpers.ts";

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
    expect(config.columns).toEqual({ include: [] });
    expect(Object.fromEntries(Object.entries(config.formulas).map(([name, expr]) => [name, expr.text]))).toEqual({ score: "quality", cost: "price", value: "-cost" });
    expect(config.policy.cheap?.text).toBe("cost <= 0.15");
    expect(config.policy.heavy?.text).toBe("score >= 55");
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
  test("plan and bounded are optional per provider", () => {
    const text = editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nplan = "Plus"\nmax_heavy = 1\nbounded = "cost > 0.5"');
    expect(parse(text).providers.openai).toMatchObject({ plan: "Plus" });
    expect(parse(text).providers.openai!.bounded?.text).toBe("cost > 0.5");
    expect(parse().providers.openai!.bounded).toBeUndefined();
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
  test("required sections and columns.include", () => {
    expect(errors("")).toEqual(['config.toml: missing "data"', 'config.toml: missing "formulas"', 'config.toml: missing "providers"', 'config.toml: missing "policy"']);
    const include = (list: string) => editedConfig("[formulas]", `[columns]\ninclude = ${list}\n\n[formulas]`);
    expect(parse(include('["quality", "price"]')).columns.include).toEqual(["quality", "price"]);
    expect(errors(include('["quality", "quality", "date"]'))).toEqual([
      'config.toml: columns.include[1]: duplicate column "quality"',
      'config.toml: columns.include[2]: "date" is not a numeric column',
    ]);
    expect(errors(include("3"))).toEqual(["config.toml: columns.include: must be an array of strings"]);
  });
  test("v1's keys fail with a hint to their replacement", () => {
    const old = editedConfig("[formulas]", '[columns]\nuse = ["quality"]\nscore = "quality"\ncost = "price"\n\n[formulas]')
      .replace('cheap = "cost <= 0.15"', "cheap_cost = 0.15")
      .replace('heavy = "score >= 55"', "heavy_score = 55")
      .replace("[providers.openai]\nmax_heavy = 1", "[providers.openai]\nmax_heavy = 1\nbounded_above_cost = 1");
    expect(errors(old)).toEqual([
      "config.toml: columns.use: no longer exists; formulas use the columns they refer to; list any other column to show in columns.include",
      'config.toml: columns.score: no longer exists; use formulas.score, as score = "intelligence"',
      'config.toml: columns.cost: no longer exists; use formulas.cost, as cost = "cost_per_task"',
      'config.toml: providers.openai.bounded_above_cost: no longer exists; use the predicate bounded, as bounded = "cost > 0.5"',
      'config.toml: policy.cheap_cost: no longer exists; use the predicate policy.cheap, as cheap = "cost <= 0.5"',
      'config.toml: policy.heavy_score: no longer exists; use the predicate policy.heavy, as heavy = "score >= 780"',
    ]);
  });
});

describe("formulas and predicates", () => {
  const formulas = (extra: string) => editedConfig('value = "-cost"', `value = "-cost"\n${extra}`);
  test("score, cost and value are required, others are free", () => {
    expect(errors(editedConfig('value = "-cost"\n', ""))).toEqual(['config.toml: formulas: missing "value"']);
    expect(errors(editedConfig('score = "quality"\ncost = "price"\n', ""))).toEqual([
      'config.toml: formulas: missing "score"',
      'config.toml: formulas: missing "cost"',
    ]);
    expect(parse(formulas('lean = "value - log2(price)"')).formulas.lean?.text).toBe("value - log2(price)");
  });
  test("names must be identifiers, and expressions must parse and give the right type", () => {
    expect(errors(formulas('"two words" = "1"\nand = "1"'))).toEqual([
      'config.toml: formulas.two words: a formula name is letters, digits and _, not starting with a digit, and not and, or or not',
      "config.toml: formulas.and: a formula name is letters, digits and _, not starting with a digit, and not and, or or not",
    ]);
    expect(errors(editedConfig('value = "-cost"', 'value = "cost <= 0.5"'))).toEqual([
      "config.toml: formulas.value: column 6: a formula must give a number, this is a comparison",
    ]);
    expect(errors(editedConfig('cheap = "cost <= 0.15"', 'cheap = "cost"'))).toEqual([
      "config.toml: policy.cheap: column 1: a predicate must be a comparison or a combination of them, this is a number",
    ]);
    expect(errors(editedConfig('heavy = "score >= 55"', 'heavy = "score >= "'))).toEqual([
      'config.toml: policy.heavy: column 10: unexpected end of the expression, expected a number, a name or "("',
    ]);
    expect(errors(editedConfig('value = "-cost"', "value = 3"))).toEqual(["config.toml: formulas.value: must be a string"]);
    expect(errors(editedConfig('value = "-cost"', 'value = " "'))).toEqual(["config.toml: formulas.value: must not be empty"]);
  });
  test("formulas can't refer to themselves, directly or through others", () => {
    expect(errors(formulas('a = "b + 1"\nb = "c * 2"\nc = "a"\nd = "d"\ne = "a"'))).toEqual([
      "config.toml: formulas.a: refers to itself through b, c",
      "config.toml: formulas.d: refers to itself",
    ]);
  });
  test("cheap and heavy are optional: absent, nothing is cheap or heavy", () => {
    const config = parse(editedConfig('cheap = "cost <= 0.15"\nheavy = "score >= 55"\n', ""));
    expect(config.policy.cheap).toBeUndefined();
    expect(config.policy.heavy).toBeUndefined();
  });
  test("a provider takes an optional heavy predicate, checked like the policy's", () => {
    const own = '[providers.openai]\nmax_heavy = 1\nheavy = "cost >= 1"';
    const config = parse(editedConfig("[providers.openai]\nmax_heavy = 1", own));
    expect(config.providers.openai?.heavy?.text).toBe("cost >= 1");
    expect(config.providers.anthropic?.heavy).toBeUndefined();
    expect(heavyOf(config, "openai")?.text).toBe("cost >= 1");
    expect(heavyOf(config, "anthropic")?.text).toBe("score >= 55");
    expect(heavyOf(parse(editedConfig('heavy = "score >= 55"\n', "")), "anthropic")).toBeUndefined();
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nmax_heavy = 1\nheavy = "x"'))).toContain(
      "config.toml: providers.openai.heavy: column 1: a predicate must be a comparison or a combination of them, this is a number",
    );
    expect(() => routing(fixtureText, editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nmax_heavy = 1\nheavy = "pric >= 1"'))).toThrow(
      'config.toml: providers.openai.heavy: column 1: unknown name "pric", neither a data column nor a formula',
    );
  });
  test("jobs take an optional value formula and where predicate", () => {
    const text = editedConfig('about = "Implement a defined task"', 'about = "Implement a defined task"\nvalue = "value - price"\nwhere = "quality < 50"');
    expect(parse(text).jobs.implement?.value?.text).toBe("value - price");
    expect(parse(text).jobs.implement?.where?.text).toBe("quality < 50");
    expect(errors(text.replace('where = "quality < 50"', 'where = "quality"'))).toEqual([
      "config.toml: jobs.implement.where: column 1: a predicate must be a comparison or a combination of them, this is a number",
    ]);
  });
  test("used columns: those every formula and predicate uses, transitively, columns.include and extra expressions", () => {
    const config = parse(formulas('unused = "speed"').replace("[formulas]", '[columns]\ninclude = ["tokens"]\n\n[formulas]'));
    expect(usedColumns(config)).toEqual(["tokens", "quality", "price", "speed"]);
    expect(usedColumns(config, [{ key: "--where", expr: compile("latency < 3", "truth") }])).toContain("latency");
  });
  test("other columns are ignored, even when they don't hold numbers", () => {
    const text = fixtureText.split("\n").map((line, i) => (line === "" ? line : i === 0 ? `${line},notes` : `${line},free text`)).join("\n");
    expect(routing(text).data.rows).toHaveLength(8);
  });
  test("names are checked against the header: unknown names, included columns and formulas named like a column", () => {
    const bad = formulas('quality = "1"\nodd = "qualty + 1"')
      .replace('heavy = "score >= 55"', 'heavy = "scor >= 55"')
      .replace("[formulas]", '[columns]\ninclude = ["ghost"]\n\n[formulas]');
    const config = parseConfig(bad, "config.toml", fixtureConfig);
    try {
      buildRouting(config, fixtureText, "config.toml", "models.csv", [{ key: "--where", expr: compile("nope > 1", "truth") }]);
      throw new Error("expected ConfigError");
    } catch (error) {
      expect((error as ConfigError).messages).toEqual([
        'config.toml: formulas.quality: "quality" is also a data column; rename the formula or the column',
        'config.toml: columns.include[0]: unknown column "ghost", not in the data',
        'config.toml: formulas.odd: column 1: unknown name "qualty", neither a data column nor a formula',
        'config.toml: policy.heavy: column 1: unknown name "scor", neither a data column nor a formula',
        '--where: column 1: unknown name "nope", neither a data column nor a formula',
      ]);
    }
  });
  test("a used column must hold a number in every row", () => {
    expect(() => routing(edited("Zed Pro,zed,high,2000-01-03,47,1.5", "Zed Pro,zed,high,2000-01-03,47,"))).toThrow(DataError);
  });
  test("non-finite values are errors with the row's file:line, the key and the column; every one is reported", () => {
    const text = editedConfig('value = "-cost"', 'value = "-log2(cost - 0.1)"').replace('heavy = "score >= 55"', 'heavy = "score / (cost - 1) > 0"');
    try {
      routing(fixtureText, text);
      throw new Error("expected ConfigError");
    } catch (error) {
      expect((error as ConfigError).messages).toEqual([
        "models.csv:3: policy.heavy: column 7: \"/\" gives Infinity",
        "models.csv:4: policy.heavy: column 7: \"/\" gives Infinity",
        "models.csv:8: formulas.value: column 2: log2() gives -Infinity",
      ]);
    }
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
      ["spare_step = 10", "spare_step = 0", "must be positive, got 0"],
      ["prefer_min_spare = -10", 'prefer_min_spare = "low"', "must be a number"],
    ];
    for (const [before, after, message] of cases) expect(errors(editedConfig(before!, after!)).some((error) => error.endsWith(message!))).toBe(true);
  });
  test("provider max_heavy, bounded and plan validate independently", () => {
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", "[providers.openai]\nmax_heavy = 0"))).toContain(
      "config.toml: providers.openai.max_heavy: must be positive, got 0",
    );
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nmax_heavy = 1\nbounded = "x"'))).toContain(
      "config.toml: providers.openai.bounded: column 1: a predicate must be a comparison or a combination of them, this is a number",
    );
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", "[providers.openai]\nmax_heavy = 1\nplan = 3"))).toContain(
      "config.toml: providers.openai.plan: must be a string",
    );
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nmax_heavy = 1\nplan = " "'))).toContain(
      "config.toml: providers.openai.plan: must not be empty",
    );
  });
  test("missing required policy and provider keys are diagnosed", () => {
    expect(errors(editedConfig("[providers.openai]\nmax_heavy = 1", "[providers.openai]"))).toContain('config.toml: providers.openai: missing "max_heavy"');
  });
  test("an empty providers table is invalid, and several issues are collected", () => {
    expect(errors('data = "x"\n[formulas]\nscore = "s"\ncost = "c"\nvalue = "-c"\n[providers]\n[policy]\nprefer = []\nprefer_min_spare = 0\nspare_step = 1\n')).toContain("config.toml: providers: must not be empty");
    const problems = errors(editedConfig("spare_step = 10", "spare_step = -1").replace('heavy = "score >= 55"', 'heavy = "score"')
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
