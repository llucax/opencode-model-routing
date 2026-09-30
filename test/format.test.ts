import { describe, expect, test } from "bun:test";
import { describeRequest, formatBrief, formatConfig, formatDuration, formatNumber, formatQuota, formatRoutes, formatSpare, formatText, jsonConfig, jsonReport, NO_WORKAROUND } from "../src/format.ts";
import { unknownQuota, type WindowState } from "../src/quota.ts";
import { buildRequest } from "../src/request.ts";
import { route } from "../src/route.ts";
import { fixtureCatalog, fixtureConfig, fixtureData } from "./helpers.ts";

const routing = fixtureData();
const quota = unknownQuota(routing.config, "test");
const report = (input: Parameters<typeof buildRequest>[0] = {}) => {
  const request = buildRequest(input, routing.config, 0);
  return { request, result: route(request, { routing, catalog: fixtureCatalog, quota }) };
};

describe("display helpers", () => {
  test("signed spare, duration and numeric precision", () => {
    expect([formatSpare(undefined), formatSpare(-12.4), formatSpare(12.5)]).toEqual(["?", "-12", "+13"]);
    expect([formatDuration(2450), formatDuration(6900), formatDuration(600000)]).toEqual(["40m", "1h55m", "6d"]);
    expect(formatNumber(3.555)).toBe("3.56");
  });
  test("quota lines include blocked/scoped windows and missing quota", () => {
    const win: WindowState = { name: "w", label: "5h", percentRemaining: 0, secondsToReset: 3600,
      spare: -20, blocked: true, models: ["Acme Big"] };
    const changed = structuredClone(quota);
    changed.providers.anthropic!.windows = [win];
    const lines = formatQuota(changed, routing.config);
    expect(lines[0]).toContain("spare -20 BLOCKED");
    expect(lines[0]).toContain("5h 0% (1h00m) -20 BLOCKED (Acme Big only)");
    expect(lines[1]).toContain("test");
  });
  test("table uses configured numeric columns, notes and no trailing spaces", () => {
    const { result } = report({ tags: ["review"] });
    const lines = formatRoutes(result.routes, routing.config.columns.use);
    expect(lines[0]).toMatch(/^provider\/model\s+effort\s+score\s+cost\s+spare\s+tags\s+notes$/);
    expect(lines.some((line) => line.includes("missing tags: review"))).toBe(true);
    expect(lines.every((line) => !line.endsWith(" "))).toBe(true);
  });
  test("request description includes job, filters and fallbacks", () => {
    expect(describeRequest(buildRequest({ job: "implement", needs: ["vision"], notModels: ["acme-big"] }, routing.config, 0)))
      .toBe("job implement, score 40-47, tags code, need vision, not model acme-big");
    expect(describeRequest(buildRequest({}, routing.config, 0))).toBe("any request");
  });
  test("quota shows provider plans and only configured providers", () => {
    const selected = structuredClone(routing.config);
    selected.providers.anthropic!.plan = "Acme Max";
    const changed = structuredClone(quota);
    changed.providers.notConfigured = { provider: "notConfigured", windows: [] };
    const rows = formatQuota(changed, selected);
    expect(rows[0]).toStartWith("anthropic (Acme Max)");
    expect(rows).toHaveLength(3);
    expect(rows.join("\n")).not.toContain("notConfigured");
  });
  test("tabular heavy notes shorten the full heavy advice", () => {
    const rows = formatRoutes(report({ score: "60+" }).result.routes, routing.config.columns.use);
    expect(rows.join("\n")).toContain("heavy (max 2)");
    expect(rows.join("\n")).toContain("bounded work only; heavy (max 1)");
    expect(rows.join("\n")).not.toContain("at a time");
  });
});

describe("route output", () => {
  test("text includes counted routes before limit, removed counts, and above-range fallback", () => {
    const { request, result } = report({ score: "40-47", limit: 1 });
    expect(formatText(result, request, quota, routing)).toContain("score 40-47: 6 routes, showing 1; removed 3 below range, 4 above range");
    const above = report({ score: "33-33", limit: 2 });
    expect(formatText(above.result, above.request, quota, routing)).toContain("none in range, 12 routes, showing 2 above range");
  });
  test("no route prints nearest; brief prints the required response instruction", () => {
    const { request, result } = report({ score: "100+" });
    expect(formatText(result, request, quota, routing)).toContain("Nearest:");
    const brief = formatBrief(result, request, quota, routing, ["guidance"]);
    expect(brief).toContain(NO_WORKAROUND);
    expect(brief).toContain("Nearest, not usable:");
    expect(brief).toEndWith("guidance");
  });
  test("a single route uses singular, with removals and no trailing whitespace", () => {
    const { request, result } = report({ needs: ["vision"] });
    const text = formatText(result, request, quota, routing);
    expect(text).toContain("need vision: 1 route; removed 12 needs");
    expect(text.split("\n").every((line) => !line.endsWith(" "))).toBe(true);
  });
  test("excluded routes appear by reason in text, brief and JSON", () => {
    const selected = structuredClone(routing);
    selected.config.exclude.push({ model: "Zed Pro", effort: "high", reason: "too slow" });
    const request = buildRequest({ score: "40-50" }, selected.config, 0);
    const result = route(request, { routing: selected, catalog: fixtureCatalog, quota });
    expect(formatText(result, request, quota, selected)).toContain("excluded: Zed Pro high (too slow)");
    expect(jsonReport(result, request, quota, selected, []).excluded).toEqual([{ model: "Zed Pro", effort: "high", reason: "too slow" }]);
    const nowhere = route(buildRequest({ score: "100+" }, selected.config, 0), { routing: selected, catalog: fixtureCatalog, quota });
    expect(formatBrief(nowhere, buildRequest({ score: "100+" }, selected.config, 0), quota, selected, [])).toContain("excluded: Zed Pro high (too slow)");
  });
  test("brief limits output and includes quota, heavy, bounded notes and used numeric values", () => {
    const { request, result } = report({ score: "60+", limit: 1 });
    const brief = formatBrief(result, request, quota, routing, []);
    expect(brief).toMatch(/anthropic\/acme-big high \(score 60, cost 5\): heavy/);
    expect(brief).toContain("1 more routes; pass limit to see them.");
    expect(brief).toContain("quota: anthropic spare ?, openai spare ?, github-copilot spare ?");
    expect(brief).toContain("Long-running workers count as heavy too.");
    const bounded = report({ score: "40-40" });
    expect(formatBrief(bounded.result, bounded.request, quota, routing, [])).toContain("Bounded work only");
  });
  test("JSON version 2, columns, job, limit, found and null unknown spare", () => {
    const { request, result } = report({ job: "implement", limit: 1 });
    const json = jsonReport(result, request, quota, routing, ["warning"]);
    expect(json).toMatchObject({ version: 2, snapshot: "2000-01-01", columns: { use: ["score", "cost"], score: "score", cost: "cost" },
      request: { job: "implement", min: 40, max: 47, tags: ["code"], limit: 1 },
      found: { routes: 6, aboveRange: 0 }, warnings: ["warning"] });
    expect((json.routes as Record<string, unknown>[])[0]!.spare).toBeNull();
    expect((json.quota as Record<string, unknown>[])[0]!.maxHeavy).toBe(2);
  });
  test("JSON preserves quota precision and null bounds, includes heavy flags", () => {
    const selected = structuredClone(quota);
    selected.providers["github-copilot"]!.windows = [{ name: "Premium", label: "monthly", percentRemaining: 30,
      secondsToReset: 86400, spare: -39.123456, blocked: false }];
    const { request, result } = report({ score: "60+" });
    const json = jsonReport(result, request, selected, routing, []);
    expect((json.quota as { provider: string; spare: number }[]).find((q) => q.provider === "github-copilot")!.spare).toBe(-39.123456);
    expect((json.request as { max: number | null }).max).toBeNull();
    expect((json.routes as { heavy: boolean; maxHeavy: number }[]).map((r) => [r.heavy, r.maxHeavy])).toEqual([[true, 2], [true, 1]]);
  });
  test("JSON nearest and above-range lists are separate from in-range routes", () => {
    const above = report({ score: "33-33" });
    const fallback = jsonReport(above.result, above.request, quota, routing, []);
    expect(fallback.routes).toEqual([]);
    expect(fallback.aboveRange).toHaveLength(12);
    const missing = report({ score: "100+" });
    const empty = jsonReport(missing.result, missing.request, quota, routing, []);
    expect(empty.routes).toEqual([]);
    expect((empty.nearest as { why: string }[])[0]!.why).toBe("below range by 40");
  });
  test("JSON config includes full provider policy and source", () => {
    const source = { config: { path: fixtureConfig, source: "--config" as const } };
    const json = jsonConfig(source, routing);
    expect(json).toMatchObject({ config: { source: "--config" },
      policy: { prefer: ["anthropic", "openai", "github-copilot"], cheapCost: 0.15 },
      providers: [{ name: "anthropic", maxHeavy: 2 }, { name: "openai" }, { name: "github-copilot", quotaName: "copilot" }] });
  });
  test("config output reports data path, jobs, aliases and exclusions", () => {
    const sources = { config: { path: fixtureConfig, source: "--config" as const } };
    const text = formatConfig(sources, routing);
    expect(text).toContain("data    ");
    expect(text).toContain("jobs\n");
    expect(text).toContain("github-copilot/acme-big.1");
    expect(jsonConfig(sources, routing)).toMatchObject({ version: 2, data: { rows: 8 }, columns: { score: "score" } });
  });
});
