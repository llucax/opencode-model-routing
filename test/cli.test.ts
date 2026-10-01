import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, configOnly, editedConfig, fixtureConfig, fixtureConfigText, fixtureDir, fixtureModels, fixtureText, staleConfigText, staleWarnings, tempDir, writeFiles } from "./helpers.ts";

const bin = join(import.meta.dir, "..", "bin", "model-route");
const models = join(fixtureDir, "models.json");
const quota = join(fixtureDir, "quota.json");
const fixed = ["--config", fixtureConfig, "--models-json", models, "--quota-json", quota, "--now", "2000-01-10T12:00:00Z"];

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([bin, ...args], { env: cliEnv(env), stdout: "pipe", stderr: "pipe" });
  return { status: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function privateConfig(text = fixtureConfigText): string {
  return join(writeFiles(tempDir(), { "config.toml": text, "models.csv": fixtureText }), "config.toml");
}

function withConfig(file: string): string[] {
  return fixed.map((part, i) => fixed[i - 1] === "--config" ? file : part);
}

const withoutConfig = fixed.filter((part, i) => part !== "--config" && fixed[i - 1] !== "--config");

describe("route CLI", () => {
  test("no options print all routes, with quota, dynamic columns and a summary", () => {
    const result = run(fixed);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("any request: 13 routes");
    expect(result.stdout).toMatch(/provider\/model\s+effort\s+value\s+quality\s+price\s+spare\s+tags\s+notes/);
    expect(result.stdout).toContain("anthropic/acme-big");
  });
  test("--job and --score default to limit 1, explicit --limit 0 returns all", () => {
    const job = run([...fixed, "--job", "implement"]);
    expect(job.status).toBe(0);
    expect(job.stdout).toContain("job implement, score 40-47, tags code: 6 routes, showing 1");
    expect(job.stdout.split("\n").filter((line) => /^(anthropic|openai|github-copilot)\//.test(line))).toHaveLength(1);
    const all = run([...fixed, "--score", "40-47", "--limit", "0"]);
    expect(all.stdout).toContain("score 40-47: 6 routes;");
    expect(all.stdout).not.toContain("showing 1");
    const limited = run([...fixed, "--limit", "2"]);
    expect(limited.stdout).toContain("any request: 13 routes, showing 2");
  });
  test("a limit above 1 prints each provider's best route, --every-route and --limit 0 print every route", () => {
    const providers = (stdout: string) => stdout.split("\n").flatMap((line) => /^(anthropic|openai|github-copilot)\//.exec(line)?.[1] ?? []);
    const best = run([...fixed, "--score", "40-47", "--limit", "3"]);
    expect(best.status).toBe(0);
    expect(providers(best.stdout)).toEqual(["anthropic", "github-copilot", "openai"]);
    expect(best.stdout).toContain("score 40-47: 6 routes, showing 3; 3 other routes of the same providers hidden, --every-route shows them");
    const every = run([...fixed, "--score", "40-47", "--limit", "3", "--every-route"]);
    expect(providers(every.stdout)).toEqual(["anthropic", "anthropic", "github-copilot"]);
    expect(every.stdout).toContain("score 40-47: 6 routes, showing 3;");
    expect(every.stdout).not.toContain("hidden");
    expect(providers(run([...fixed, "--score", "40-47", "--limit", "0"]).stdout)).toHaveLength(6);
    expect(providers(run([...fixed, "--score", "40-47"]).stdout)).toHaveLength(1);
    expect(providers(run([...fixed, "--score", "40-47", "--every-route"]).stdout)).toHaveLength(1);
    const json = JSON.parse(run([...fixed, "--score", "40-47", "--limit", "3", "--json"]).stdout);
    expect(json).toMatchObject({ found: { routes: 6, sameProvider: 3 }, request: { everyRoute: false } });
    expect(json.routes).toHaveLength(3);
    expect(JSON.parse(run([...fixed, "--score", "40-47", "--limit", "3", "--every-route", "--json"]).stdout)).toMatchObject({
      found: { routes: 6, sameProvider: 0 }, request: { everyRoute: true },
    });
  });
  test("--json contains version, found before cut, columns, job and limit", () => {
    const result = run([...fixed, "--job", "implement", "--limit", "2", "--json"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({ version: 3, formulas: { value: "-cost" },
      request: { job: "implement", min: 40, max: 47, tags: ["code"], limit: 2, value: "-cost", where: null }, found: { routes: 6 } });
    expect(json.routes).toHaveLength(2);
  });
  test("--value and --where replace the job's or the default, and their columns are read", () => {
    const data = fixtureText.split("\n").map((line, i) => (line === "" ? line : i === 0 ? `${line},speed` : `${line},${10 - i}`)).join("\n");
    const file = join(writeFiles(tempDir(), { "config.toml": fixtureConfigText, "models.csv": data }), "config.toml");
    const args = [...withConfig(file), "--json", "--limit", "0"];
    const plain = JSON.parse(run(args).stdout);
    expect(plain.shown.columns).toEqual(["quality", "price"]);
    const fast = JSON.parse(run([...args, "--value", "speed", "--where", "speed >= 5 and quality > 30"]).stdout);
    expect(fast.request).toMatchObject({ value: "speed", where: "speed >= 5 and quality > 30" });
    expect(fast.shown.columns).toEqual(["quality", "price", "speed"]);
    expect(fast.removed.where).toBe(6);
    expect(fast.routes).toHaveLength(7);
    expect(fast.routes[0]).toMatchObject({ value: 9, shown: { quality: 60, price: 5, speed: 9 } });
    const text = run([...withConfig(file), "--value", "speed", "--where", "speed >= 5"]);
    expect(text.stdout).toMatch(/provider\/model\s+effort\s+value\s+quality\s+price\s+speed\s+spare/);
    expect(text.stdout).toContain("value speed, where speed >= 5: 8 routes; removed 5 failing where");
    expect(text.stdout).toContain("failing where");
  });
  test("--value and --where errors name the option and the column", () => {
    expect(run([...fixed, "--value", "price < 1"])).toMatchObject({ status: 1, stderr: "model-route: --value: column 7: a formula must give a number, this is a comparison\n" });
    expect(run([...fixed, "--where", "price"])).toMatchObject({ status: 1, stderr: "model-route: --where: column 1: a predicate must be a comparison or a combination of them, this is a number\n" });
    expect(run([...fixed, "--where", "pric < 1"])).toMatchObject({ status: 1, stderr: 'model-route: --where: column 1: unknown name "pric", neither a data column nor a formula\n' });
    expect(run([...fixed, "--value", "1 / (price - 1)"]).stderr).toContain(": --value: column 3: \"/\" gives Infinity");
    expect(run(["check", "--config", fixtureConfig, "--where", "price < 1"]).stderr).toBe("model-route: --where does not apply to check; see --help\n");
  });
  test("explicit tags replace job's even when empty", () => {
    const result = run([...fixed, "--job", "implement", "--tags", "", "--json"]);
    expect(JSON.parse(result.stdout).request.tags).toEqual([]);
  });
  test("missing routes exit 2; invalid job, tag, limit and catalog exit 1", () => {
    const empty = run([...fixed, "--score", "100+"]);
    expect(empty.status).toBe(2);
    expect(empty.stdout).toContain("No route matches score 100+");
    expect(empty.stdout).toContain("Nearest:");
    for (const [args, message] of [
      [["--job", "unknown"], 'unknown job "unknown"'],
      [["--tags", "unknown"], 'unknown tag "unknown"'],
      [["--limit=-1"], 'invalid --limit "-1"'],
    ] as const) {
      const result = run([...fixed, ...args]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    }
    const unavailable = run([...fixed, "--models-json", join(tempDir(), "missing.json")]);
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain("without the provider catalog no model can be matched");
  });
  test("need, not-model, unknown not-model warning and above-range fallback", () => {
    const vision = run([...fixed, "--need", "vision"]);
    expect(vision.stdout).toContain("need vision: 1 route; removed 12 needs");
    const avoided = run([...fixed, "--not-model", "github-copilot/acme-big.1"]);
    expect(avoided.stdout).toContain("removed 4 same model");
    const warning = run([...fixed, "--not-model", "ghost"]);
    expect(warning.stderr).toContain('not_model "ghost" matches no model in the data');
    const above = run([...fixed, "--score", "33-33"]);
    expect(above.stdout).toContain("none in range, 12 routes, showing 1 above range");
  });
  test("config command reports paths, effective values and versioned JSON", () => {
    const text = run(["config", "--config", fixtureConfig]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain(`data    ${fixtureModels} (8 rows, snapshot 2000-01-01)`);
    expect(text.stdout).toContain("implement");
    const json = run(["config", "--json", "--config", fixtureConfig]);
    expect(JSON.parse(json.stdout)).toMatchObject({ version: 3, data: { rows: 8 }, formulas: { score: "quality" } });
  });
  test("--data overrides the CSV configured for route and config commands", () => {
    const alternate = writeFiles(tempDir(), { "alternate.csv": fixtureText.replace("Zed Lite,zed,medium,2000-01-03,35,0.1", "Zed Lite,zed,medium,2000-01-03,39,0.1") });
    const path = join(alternate, "alternate.csv");
    const route = run([...fixed, "--data", path, "--score", "39-39", "--json"]);
    expect(route.status).toBe(0);
    expect(JSON.parse(route.stdout).found.routes).toBe(2);
    expect(run(["config", "--config", fixtureConfig, "--data", path]).stdout).toContain(`data    ${path}`);
  });
});

describe("route CLI details", () => {
  test("quota table reports full synthetic window values and ranking by provider", () => {
    const result = run([...fixed, "--score", "40-47", "--tags", "code", "--limit", "0"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("5h 77% (2h00m) +37");
    expect(result.stdout).toContain("Acme Big Weekly 100% (3d) +50 (Acme Big only)");
    expect(result.stdout).toContain("Premium 30% (21d)");
    const lines = result.stdout.split("\n").filter((line) => /^(anthropic|openai|github-copilot)\//.test(line));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toStartWith("anthropic/");
  });
  test("repeated --need and --not-model values match comma-separated values", () => {
    const repeat = run([...fixed, "--not-model", "acme-big", "--not-model", "zed-pro"]);
    expect(repeat.stdout).toBe(run([...fixed, "--not-model", "acme-big,zed-pro"]).stdout);
    expect(repeat.stdout).toContain("removed 8 same model");
    expect(run([...fixed, "--need", "vision,vision"]).stdout).toContain("need vision: 1 route");
  });
  test("missing quota file warns and routes with unknown spare", () => {
    const result = run([...fixed, "--quota-json", "/nonexistent/quota.json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toStartWith("warning: quota data unavailable (/nonexistent/quota.json unreadable");
    expect(result.stdout).toContain("spare ?");
  });
  test("when no quota JSON is given, the installed quota CLI supplies it", () => {
    const home = writeFiles(tempDir(), {
      ".cache/opencode/packages/@slkiser/opencode-quota@2.0.0/node_modules/@slkiser/opencode-quota/dist/bin/opencode-quota.js":
        `console.log(${JSON.stringify(JSON.stringify({ providers: { openai: { status: "ok", entries: [
          { name: "W", renderType: "percent", window: "weekly", percentRemaining: 100, resetAt: 947592000 },
        ] } } }))});`,
    });
    const result = run(["--config", fixtureConfig, "--models-json", models, "--now", "2000-01-10T12:00:00Z"], { HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/openai +spare [+-]\d+ +weekly 100%/);
  });
  test("single provider removes unavailable models once per data row", () => {
    const result = run(withConfig(privateConfig(configOnly("github-copilot"))));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("any request: 6 routes; removed 2 no provider");
    expect(result.stdout).not.toMatch(/^anthropic\s+spare/m);
    expect(JSON.parse(run([...withConfig(privateConfig(configOnly("github-copilot"))), "--json"]).stdout).removed.noProvider).toBe(2);
  });
  test("provider-prefixed data IDs remain valid --not-model values even if provider is unconfigured", () => {
    const result = run([...withConfig(privateConfig(configOnly("github-copilot"))), "--not-model", "anthropic/Acme Big"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("not model anthropic/Acme Big: 4 routes; removed 2 no provider, 2 same model");
  });
  test("avoiding all candidates with one configured provider exits 2", () => {
    const result = run([...withConfig(privateConfig(configOnly("anthropic"))), "--not-model", "acme-big,acme-small"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("No route matches not model acme-big,acme-small");
    expect(result.stdout).toContain("removed 4 no provider, 4 same model");
  });
  test("plan appears in text and JSON quota lines", () => {
    const file = privateConfig(editedConfig("[providers.anthropic]\n", '[providers.anthropic]\nplan = "Acme Max"\n'));
    expect(run(withConfig(file)).stdout).toMatch(/^anthropic \(Acme Max\) +spare/);
    const json = JSON.parse(run([...withConfig(file), "--json"]).stdout);
    expect(json.quota.map((entry: { plan?: string }) => entry.plan)).toEqual(["Acme Max", undefined, undefined]);
  });
  test("heavy and bounded notes are abbreviated in text but complete in JSON", () => {
    const text = run([...fixed, "--score", "60+", "--limit", "0"]);
    expect(text.stdout).toContain("heavy (max 2)");
    expect(text.stdout).toContain("bounded work only; heavy (max 1)");
    expect(text.stdout).not.toContain("at a time");
    const json = JSON.parse(run([...fixed, "--score", "60+", "--limit", "0", "--json"]).stdout);
    expect(json.routes.map((r: { provider: string; heavy: boolean; maxHeavy: number }) => [r.provider, r.heavy, r.maxHeavy]))
      .toEqual([["anthropic", true, 2], ["github-copilot", true, 1]]);
    expect(json.routes[0].notes).toEqual(["heavy, at most 2 at a time on anthropic"]);
  });
  test("excluded effort's reason is printed and included in JSON", () => {
    const file = privateConfig(fixtureConfigText + '\n[[exclude]]\nmodel = "Zed Pro"\neffort = "high"\nreason = "too slow"\n');
    expect(run([...withConfig(file), "--score", "40-50", "--limit", "0"]).stdout).toContain("excluded: Zed Pro high (too slow)");
    expect(JSON.parse(run([...withConfig(file), "--json"]).stdout).excluded).toEqual([{ model: "Zed Pro", effort: "high", reason: "too slow" }]);
  });
  test("JSON exit 2 contains nearest, above-range fallback uses separate list", () => {
    const empty = run([...fixed, "--score", "100+", "--json"]);
    expect(empty.status).toBe(2);
    expect(JSON.parse(empty.stdout).nearest[0].why).toBe("below range by 40");
    const above = JSON.parse(run([...fixed, "--score", "33-33", "--limit", "0", "--json"]).stdout);
    expect(above.routes).toEqual([]);
    expect(above.aboveRange).toHaveLength(12);
  });
  test("warnings appear both on stderr and in JSON", () => {
    const result = run([...fixed, "--not-model", "mystery-9", "--json"]);
    const warning = 'not_model "mystery-9" matches no model in the data';
    expect(result.stderr).toBe(`warning: ${warning}\n`);
    expect(JSON.parse(result.stdout).warnings).toEqual([warning]);
  });
});

describe("check CLI", () => {
  test("--data validates alone, without config, models.json or quota", () => {
    expect(run(["check", "--data", fixtureModels])).toEqual({ status: 0, stdout: "OK: 8 rows of 5 models, 6 columns\n", stderr: "" });
    const dir = writeFiles(tempDir(), { "invalid.csv": 'model,vendor,effort,score\nA,a,none,NaN\n' });
    const result = run(["check", "--data", join(dir, "invalid.csv")]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("invalid.csv:2: score \"NaN\" is not a finite number");
    expect(result.stderr).toBe("");
  });
  test("--data alone rejects config and catalog options", () => {
    for (const arg of ["--config", "--models-json", "--config-dir"]) {
      const result = run(["check", "--data", fixtureModels, arg, "unused"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`--${arg.slice(2)} does not apply to check --data`);
    }
  });
  test("full check reports unoffered data models and stale recommendations", () => {
    const dir = writeFiles(tempDir(), { "AGENTS.md": "--job unknown\n--score 90-99\nopenai/ghost" });
    const bad = run(["check", "--config", fixtureConfig, "--models-json", models, "--config-dir", dir]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('unknown job "unknown"');
    expect(bad.stdout).toContain("no route has a score in 90-99");
    expect(bad.stdout).toContain("unknown model openai/ghost");
    const clean = run(["check", "--config", fixtureConfig, "--models-json", models, "--config-dir", writeFiles(tempDir(), { "AGENTS.md": "--job implement" })]);
    expect(clean.stdout).toBe("OK: 8 rows of 5 models and 1 configuration files checked\n");
    const catalog = JSON.parse(Bun.spawnSync(["cat", models]).stdout.toString());
    delete catalog["github-copilot"].models["vista-1"];
    const catalogDir = writeFiles(tempDir(), { "models.json": JSON.stringify(catalog) });
    const unoffered = run(["check", "--config", fixtureConfig, "--models-json", join(catalogDir, "models.json"), "--config-dir", writeFiles(tempDir(), { "AGENTS.md": "" })]);
    expect(unoffered.stdout).toContain('model "Vista" is offered by none of the configured providers');
  });
  test("routing flags and stray arguments don't apply to check", () => {
    const rejected = run(["check", "--job", "implement"]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("--job does not apply to check");
    expect(run(["unexpected"]).stderr).toContain('unexpected argument "unexpected"');
    expect(run(["--config-dir", "unused"]).stderr).toContain("--config-dir only applies to check");
  });
  test("missing catalog exits 1 without silently accepting every model", () => {
    const result = run(["check", "--config", fixtureConfig, "--models-json", join(tempDir(), "missing.json"),
      "--config-dir", writeFiles(tempDir(), { "AGENTS.md": "" })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("without the provider catalog no model can be matched");
  });
  test("malformed data prints its problems on stdout and exit 1", () => {
    const dir = writeFiles(tempDir(), { "config.toml": fixtureConfigText,
      "models.csv": fixtureText.replace("Acme Big,acme,low,2000-01-01,40,1", "Acme Big,acme,invalid,2000-01-01,NaN,1") });
    const result = run(["check", "--config", join(dir, "config.toml"), "--models-json", models]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('unknown effort "invalid"');
    expect(result.stdout).toContain('quality "NaN" is not a finite number');
  });
  test("model references absent from the data are warnings that don't fail the check", () => {
    const file = privateConfig(staleConfigText);
    const result = run(["check", "--config", file, "--models-json", models, "--config-dir", writeFiles(tempDir(), { "AGENTS.md": "" })]);
    expect(result).toEqual({
      status: 0,
      stdout: [...staleWarnings(file).map((w) => `warning: ${w}`), "OK: 8 rows of 5 models and 1 configuration files checked", ""].join("\n"),
      stderr: "",
    });
  });
  test("stale warnings come before the problems, which still fail the check", () => {
    const file = privateConfig(staleConfigText);
    const result = run(["check", "--config", file, "--models-json", models, "--config-dir", writeFiles(tempDir(), { "AGENTS.md": "--job unknown" })]);
    expect(result.status).toBe(1);
    expect(result.stdout.split("\n").slice(0, 6)).toEqual([...staleWarnings(file).map((w) => `warning: ${w}`), expect.stringContaining('unknown job "unknown"')]);
  });
  test("routing ignores stale references, and only the quota line shows a window's models as configured", () => {
    const clean = run([...withConfig(privateConfig()), "--job", "implement", "--limit", "0"]);
    const stale = run([...withConfig(privateConfig(staleConfigText)), "--job", "implement", "--limit", "0"]);
    expect(stale.status).toBe(0);
    expect(stale.stderr).toBe("");
    expect(stale.stdout.replace("(Acme Big, Phantom only)", "(Acme Big only)")).toBe(clean.stdout);
  });
  test("invalid config syntax is reported without trying a missing data path", () => {
    const file = privateConfig(editedConfig("spare_step = 10", "spare_step = 0"));
    const result = run(["check", "--config", file, "--models-json", "/nonexistent/catalog.json"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${file}: policy.spare_step: must be positive, got 0`);
    expect(result.stderr).toBe("");
  });
  test("missing config is a check problem rather than a fatal stderr error", () => {
    const result = run(["check", "--config", "/nonexistent/config.toml"]);
    expect(result).toEqual({ status: 1, stdout: "/nonexistent/config.toml: cannot read: no such file (from --config)\n", stderr: "" });
  });
  test("check recommendations use the configured providers", () => {
    const dir = writeFiles(tempDir(), { "AGENTS.md": "--score 55+" });
    const all = run(["check", "--config", fixtureConfig, "--models-json", models, "--config-dir", dir]);
    expect(all.status).toBe(0);
    const only = run(["check", "--config", privateConfig(configOnly("openai")), "--models-json", models, "--config-dir", dir]);
    expect(only.status).toBe(1);
    expect(only.stdout).toContain("no route has a score in 55+");
  });
  test("missing config directory is a check problem", () => {
    const dir = join(tempDir(), "missing");
    const result = run(["check", "--config", fixtureConfig, "--models-json", models, "--config-dir", dir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${dir}: no such configuration directory`);
  });
  test("check rejects every routing-only option and stray positionals", () => {
    for (const option of [["--score", "40+"], ["--json"], ["--tags", "code"], ["--now", "2000-01-01"],
      ["--job", "implement"], ["--limit", "2"], ["--every-route"], ["--need", "vision"], ["--not-model", "ghost"],
      ["--quota-json", quota]]) {
      const result = run(["check", "--config", fixtureConfig, ...option]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not apply to check");
    }
    expect(run(["check", "more"]).stderr).toContain('unexpected argument "more"');
  });
});

describe("CLI config lookup", () => {
  test("--config wins over a bad environment config", () => {
    expect(run(fixed, { MODEL_ROUTING_CONFIG: "/nonexistent/config.toml" }).status).toBe(0);
  });
  test("uses $MODEL_ROUTING_CONFIG when no --config was given", () => {
    expect(run(withoutConfig, { MODEL_ROUTING_CONFIG: fixtureConfig }).stdout).toContain("any request: 13 routes");
  });
  test("default path under $XDG_CONFIG_HOME or $HOME/.config", () => {
    const xdg = writeFiles(tempDir(), { "opencode/model-routing/config.toml": fixtureConfigText,
      "opencode/model-routing/models.csv": fixtureText });
    expect(run(withoutConfig, { XDG_CONFIG_HOME: xdg }).status).toBe(0);
    expect(run(withoutConfig, { MODEL_ROUTING_CONFIG: "", XDG_CONFIG_HOME: xdg }).status).toBe(0);
    const home = writeFiles(tempDir(), { ".config/opencode/model-routing/config.toml": fixtureConfigText,
      ".config/opencode/model-routing/models.csv": fixtureText });
    expect(run(withoutConfig, { HOME: home }).status).toBe(0);
  });
  test("explicit missing config is an error and does not try environment fallback", () => {
    const result = run([...withoutConfig, "--config", "/nonexistent/config.toml"], { MODEL_ROUTING_CONFIG: fixtureConfig });
    expect(result).toEqual({ status: 1, stdout: "", stderr: "model-route: /nonexistent/config.toml: cannot read: no such file (from --config)\n" });
  });
  test("missing environment config doesn't try the default path", () => {
    const xdg = writeFiles(tempDir(), { "opencode/model-routing/config.toml": fixtureConfigText,
      "opencode/model-routing/models.csv": fixtureText });
    const result = run(withoutConfig, { MODEL_ROUTING_CONFIG: "/nonexistent/config.toml", XDG_CONFIG_HOME: xdg });
    expect(result.stderr).toBe("model-route: /nonexistent/config.toml: cannot read: no such file (from $MODEL_ROUTING_CONFIG)\n");
  });
  test("missing default config points at the example", () => {
    const result = run(withoutConfig, { XDG_CONFIG_HOME: tempDir() });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no configuration at ");
    expect(result.stderr).toContain("examples/config.toml");
  });
  test("invalid config reports multiple problems with config file path", () => {
    const file = privateConfig(editedConfig("spare_step = 10", "spare_step = 0")
      .replace('bounded_only = ["Acme Big"]', 'bounded_only = ["Nobody"]\nlimit = 3')
      .replace('prefer = ["anthropic", "openai", "github-copilot"]', 'prefer = ["anthropic", "nowhere"]'));
    const result = run(withConfig(file));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(result.stderr).toContain(`${file}: policy.spare_step: must be positive, got 0`);
    expect(result.stderr).toContain(`${file}: providers.github-copilot: unknown key "limit"`);
  });
  test("config command states file source and shows policy, providers, tags, jobs and aliases", () => {
    const result = run(["config", "--config", fixtureConfig]);
    expect(result.stdout).toStartWith(`config  ${fixtureConfig} (from --config)\n`);
    for (const part of ["formulas\n", "policy\n", "prefer_min_spare", "Acme Big Weekly", "jobs\n", "tags\n", "models\n", "github-copilot/acme-big.1"]) {
      expect(result.stdout).toContain(part);
    }
    expect(run(["config", "--config", fixtureConfig], { MODEL_ROUTING_CONFIG: "/nonexistent/config.toml" }).status).toBe(0);
    expect(run(["config"], { MODEL_ROUTING_CONFIG: fixtureConfig }).stdout).toContain("(from $MODEL_ROUTING_CONFIG)");
  });
  test("config JSON includes source, policy, providers, tags, jobs, model aliases and exclusions", () => {
    const file = privateConfig(fixtureConfigText + '\n[[exclude]]\nmodel = "Vista"\nreason = "unused"\n');
    const json = JSON.parse(run(["config", "--config", file, "--json"]).stdout);
    expect(json).toMatchObject({ version: 3, config: { source: "--config", path: file },
      data: { rows: 8, snapshot: "2000-01-01" }, columns: { include: [] }, formulas: { score: "quality", cost: "price", value: "-cost" },
      policy: { prefer: ["anthropic", "openai", "github-copilot"] },
      tags: { vision: "images." }, jobs: [{ name: "implement", score: "40-47" }],
      exclude: [{ model: "Vista", effort: null, reason: "unused" }],
    });
    expect(json.providers[2]).toMatchObject({ name: "github-copilot", quotaName: "copilot", boundedOnly: ["Acme Big"] });
  });
  test("config rejects route-only and check-only flags", () => {
    for (const option of [["--score", "40+"], ["--now", "2000-01-01"], ["--models-json", models],
      ["--config-dir", tempDir()], ["--job", "implement"]]) {
      const result = run(["config", "--config", fixtureConfig, ...option]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not apply to config");
    }
  });
  test("config with an explicitly missing file fails without stack trace", () => {
    const result = run(["config", "--config", "/nonexistent/config.toml"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cannot read: no such file");
    expect(result.stderr).not.toContain(" at ");
  });
});

describe("CLI errors and wrapper", () => {
  test("invalid score syntax, unknown need, invalid --now and invalid limit exit 1", () => {
    for (const score of ["47-40", "abc", "40", "40-"]) {
      const result = run([...fixed, "--score", score]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("invalid score range");
      expect(result.stdout).toBe("");
    }
    expect(run([...fixed, "--need", "telepathy"]).stderr).toContain('unknown need "telepathy"');
    expect(run([...fixed, "--now", "yesterday-ish"]).stderr).toContain("invalid --now");
    expect(run([...fixed, "--limit=1.5"]).stderr).toContain('invalid --limit "1.5"');
  });
  test("unknown tag lists configured tag definitions", () => {
    const result = run([...fixed, "--tags", "code,mystery"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown tag "mystery"; the known tags are:');
    expect(result.stderr).toContain("plan    planning and design.");
    expect(result.stderr).toContain("vision  images.");
  });
  test("unknown option and stray positional are concise errors", () => {
    expect(run([...fixed, "--frobnicate"]).stderr).toContain("--frobnicate");
    expect(run([...fixed, "extra"]).stderr).toContain('unexpected argument "extra"');
  });
  test("missing CSV, CSV syntax error and multiple invalid rows are labeled", () => {
    const missing = run([...fixed, "--data", "/nonexistent/models.csv"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("/nonexistent/models.csv: cannot read: no such file");
    const bad = writeFiles(tempDir(), { "bad.csv": 'model,vendor,effort,score,cost\n"unfinished',
      "rows.csv": fixtureText.replace("Acme Big,acme,low,2000-01-01,40,1", "Acme Big,acme,invalid,2000-01-01,40,1")
        .replace("Acme Big,acme,high,2000-01-02,60,5", "Acme Big,acme,high,2000-01-02,NaN,5"),
    });
    expect(run([...fixed, "--data", join(bad, "bad.csv")]).stderr).toContain("CSV syntax error: unterminated quoted field");
    const rows = run([...fixed, "--data", join(bad, "rows.csv")]);
    expect(rows.status).toBe(1);
    expect(rows.stderr).toContain('unknown effort "invalid"');
    expect(rows.stderr).toContain('quality "NaN" is not a finite number');
    expect(rows.stderr.split("\n").filter(Boolean)).toHaveLength(2);
  });
  test("help exits 0 with all commands, data-only validation and limit documented", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    for (const part of ["Usage: model-route", "--job NAME", "--limit N", "--score RANGE", "--config FILE", "MODEL_ROUTING_CONFIG",
      "model-route check --data FILE", "model-route config [--json]"]) expect(help.stdout).toContain(part);
  });
  test("wrapper finds bun from ~/.bun/bin with empty environment", () => {
    const home = tempDir();
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(home, ".bun", "bin", "bun"));
    const processResult = Bun.spawnSync(["env", "-i", `HOME=${home}`, "PATH=/usr/bin:/bin", bin, ...fixed,
      "--score", "40-47"], { stdout: "pipe", stderr: "pipe" });
    expect(processResult.exitCode).toBe(0);
    expect(processResult.stdout.toString()).toContain("6 routes, showing 1");
  });
  test.skipIf(existsSync("/usr/bin/bun") || existsSync("/bin/bun"))("wrapper says how to install bun when unavailable", () => {
    const result = Bun.spawnSync(["env", "-i", `HOME=${tempDir()}`, "PATH=/usr/bin:/bin", bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("model-route: bun not found in PATH or in $HOME/.bun/bin\n");
  });
  test("wrapper works through a symlink from another directory", () => {
    const dir = tempDir();
    symlinkSync(bin, join(dir, "mr"));
    const result = Bun.spawnSync([join(dir, "mr"), ...fixed, "--score", "40-47"], {
      cwd: tempDir(), env: cliEnv(), stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("6 routes, showing 1");
  });
});
