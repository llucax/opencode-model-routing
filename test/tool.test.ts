import { describe, expect, test } from "bun:test";
import { ConfigError } from "../src/config.ts";
import { NO_WORKAROUND } from "../src/format.ts";
import type { RunningSession } from "../src/live.ts";
import { unknownQuota } from "../src/quota.ts";
import { countHeavy, runTool, ToolError, toolDescription, toolParameters, type ToolArgs, type ToolDeps } from "../src/tool.ts";
import { editedConfig, fixtureCatalog, fixtureData, fixtureText, routing as routingOf } from "./helpers.ts";

const routing = fixtureData();
const session = (providerID: string, modelID: string, variant?: string): RunningSession => ({
  id: `s-${providerID}-${modelID}-${variant ?? "none"}`, directory: "/work",
  model: { providerID, modelID, ...(variant ? { variant } : {}) },
});

function deps(sessions: RunningSession[] = []): ToolDeps {
  return {
    routing: () => routing,
    catalog: async () => ({ catalog: fixtureCatalog, warnings: [] }),
    quota: async (config) => unknownQuota(config, "no data"),
    sessions: async () => ({ sessions, warnings: [] }),
  };
}

describe("heavy running sessions", () => {
  test("an exact heavy effort counts, an exact light effort does not", () => {
    const result = countHeavy([session("anthropic", "acme-big", "high"), session("anthropic", "acme-big", "low"),
      session("openai", "zed-pro", "xhigh")], routing, fixtureCatalog);
    expect(result.running).toEqual({ anthropic: 1, openai: 0, "github-copilot": 0 });
    expect(result.notes).toEqual([]);
  });
  test("missing variant or an unknown or absent effort uses any heavy data row", () => {
    const result = countHeavy([
      session("anthropic", "acme-big"), session("anthropic", "acme-big", "default"),
      session("github-copilot", "acme-big.1", "max"), session("openai", "zed-pro", "low"),
      session("anthropic", "acme-small"),
    ], routing, fixtureCatalog);
    expect(result.running).toEqual({ anthropic: 2, openai: 0, "github-copilot": 1 });
    expect(result.notes).toEqual(["5 running sessions' effort is not in the data; counted as heavy if the model has a heavy effort."]);
  });
  test("alias-matched provider IDs count; unrelated provider or data-absent ID does not", () => {
    const result = countHeavy([
      session("github-copilot", "acme-big.1", "high"), session("other", "acme-big", "high"),
      session("anthropic", "not-in-data", "high"),
    ], routing, fixtureCatalog);
    expect(result.running).toEqual({ anthropic: 0, openai: 0, "github-copilot": 1 });
    expect(result.notes).toEqual([]);
  });
  test("the heavy predicate decides, whatever it reads; without one nothing is heavy", () => {
    const byCost = routingOf(fixtureText, editedConfig('heavy = "score >= 55"', 'heavy = "cost >= 2"'));
    expect(countHeavy([session("openai", "zed-pro", "xhigh"), session("openai", "zed-pro", "high")], byCost, fixtureCatalog).running.openai).toBe(1);
    const none = routingOf(fixtureText, editedConfig('heavy = "score >= 55"\n', ""));
    expect(countHeavy([session("anthropic", "acme-big", "high"), session("anthropic", "acme-big")], none, fixtureCatalog).running.anthropic).toBe(0);
  });
  test("running sessions without a model add a note, but not to a provider's count", () => {
    const result = countHeavy([{ id: "first", directory: "/work" }, { id: "second", directory: "/other" }], routing, fixtureCatalog);
    expect(result.running).toEqual({ anthropic: 0, openai: 0, "github-copilot": 0 });
    expect(result.notes).toEqual(["2 running sessions have no model yet and were not counted."]);
    expect(countHeavy([{ id: "one", directory: "/work" }], routing, fixtureCatalog).notes).toEqual([
      "1 running session has no model yet and was not counted.",
    ]);
  });
});

describe("tool metadata", () => {
  test("description lists configured jobs and their purpose", () => {
    const description = toolDescription(routing.config);
    expect(description).toContain("Jobs: implement 40-47 code (Implement a defined task).");
    expect(description).toContain("Pick the model and variant");
    expect(description).not.toContain("\n");
  });
  test("job parameter is an enum when there are jobs; need and limit are validated", () => {
    const params = toolParameters(routing.config);
    expect(params.job.safeParse("implement").success).toBe(true);
    expect(params.job.safeParse("other").success).toBe(false);
    expect(params.job.safeParse(undefined).success).toBe(true);
    expect(params.need.safeParse(["vision"]).success).toBe(true);
    expect(params.need.safeParse(["audio"]).success).toBe(false);
    expect(params.limit.safeParse(0).success).toBe(true);
    expect(params.limit.safeParse(-1).success).toBe(false);
    expect(params.limit.safeParse(1.2).success).toBe(false);
  });
  test("without configured jobs, description omits the list and job accepts any string", () => {
    const config = { ...routing.config, jobs: {} };
    expect(toolDescription(config)).not.toContain("Jobs:");
    expect(toolDescription(undefined)).toBe(toolDescription(config));
    expect(toolParameters(config).job.safeParse("new-job").success).toBe(true);
    expect(toolParameters(undefined).job.safeParse("new-job").success).toBe(true);
  });
});

describe("tool execution with fake dependencies", () => {
  test("returns the first route's title and brief output, with default limit 1", async () => {
    const result = await runTool({ job: "implement" }, deps());
    expect(result.title).toBe("anthropic/acme-small high");
    expect(result.routes).toHaveLength(1);
    expect(result.output).toContain("(value -1, quality 45, price 1)");
    expect(result.output).toContain("5 more routes; pass limit to see them.");
    expect(result.output).toContain("quota: anthropic spare ?, openai spare ?, github-copilot spare ?");
  });
  test("limit 0 exposes every route; explicit score overrides the job", async () => {
    const result = await runTool({ job: "implement", score: "60+", tags: [], limit: 0 }, deps());
    expect(result.routes).toHaveLength(2);
    expect(result.title).toBe("anthropic/acme-big high");
    expect(result.output).not.toContain("more routes; pass limit");
  });
  test("running heavy sessions at their limits remove the provider's heavy route", async () => {
    const running = [session("anthropic", "acme-big", "high"), session("anthropic", "acme-big", "high")];
    const result = await runTool({ score: "60+" }, deps(running));
    expect(result.title).toBe("github-copilot/acme-big.1 high");
    expect(result.routes).toHaveLength(1);
    expect(result.output).toContain("heavy, 0 of 1 running on github-copilot");
  });
  test("no usable route retains the no-route title and non-workaround advice", async () => {
    const result = await runTool({ score: "100+" }, deps());
    expect(result.title).toBe("no route");
    expect(result.routes).toEqual([]);
    expect(result.output).toContain("Nearest, not usable:");
    expect(result.output).toEndWith(NO_WORKAROUND);
  });
  test("notes and source warnings are appended to successful output", async () => {
    const custom: ToolDeps = {
      ...deps([{ id: "no-model", directory: "/work" }]),
      catalog: async () => ({ catalog: fixtureCatalog, warnings: ["catalog stale"] }),
      quota: async (config) => ({ ...unknownQuota(config, "test"), warnings: ["quota stale"] }),
      sessions: async () => ({ sessions: [{ id: "no-model", directory: "/work" }], warnings: ["status stale"] }),
    };
    const result = await runTool({ score: "60+" }, custom);
    expect(result.output).toContain("1 running session has no model yet and was not counted.");
    expect(result.output).toContain("warning: catalog stale");
    expect(result.output).toContain("warning: quota stale");
    expect(result.output).toContain("warning: status stale");
  });
  test("job or score is required before accessing dependencies", async () => {
    const unused: ToolDeps = { ...deps(), routing: () => { throw new Error("should not load routing"); } };
    await expect(runTool({}, unused)).rejects.toThrow("pass `job` or `score`");
    await expect(runTool({}, unused)).rejects.toThrow(ToolError);
    try { await runTool({}, unused); }
    catch (error) { expect((error as ToolError).message).toEndWith(NO_WORKAROUND); }
  });
  test("unknown jobs, tags and invalid limits become ToolError ending in advice", async () => {
    const cases: { args: ToolArgs; text: string }[] = [
      { args: { job: "unknown" }, text: 'unknown job "unknown"' },
      { args: { score: "40+", tags: ["unlisted"] }, text: 'unknown tag "unlisted"' },
      { args: { score: "40+", limit: -1 }, text: "invalid limit -1" },
    ];
    for (const { args, text } of cases) {
      try { await runTool(args, deps()); throw new Error("expected ToolError"); }
      catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        expect((error as ToolError).message).toContain(text);
        expect((error as ToolError).message).toEndWith(NO_WORKAROUND);
      }
    }
  });
  test("configuration validation failures become ToolError with all messages and advice", async () => {
    const invalid: ToolDeps = { ...deps(), routing: () => { throw new ConfigError(["data: bad row", "config: bad model"]); } };
    try { await runTool({ score: "40+" }, invalid); throw new Error("expected ToolError"); }
    catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).message).toBe(`data: bad row\nconfig: bad model\n${NO_WORKAROUND}`);
    }
  });
});
