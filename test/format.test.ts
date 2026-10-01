import { describe, expect, test } from "bun:test";
import { describeRequest, formatBrief, formatConfig, formatDuration, formatNumber, formatQuota, formatRoutes, formatSpare, formatText, jsonConfig, jsonReport, NO_WORKAROUND, PREVIEW_CHARS } from "../src/format.ts";
import { unknownQuota, type WindowState } from "../src/quota.ts";
import { buildRequest } from "../src/request.ts";
import { route } from "../src/route.ts";
import { compile } from "../src/expr.ts";
import { shownColumns } from "../src/formulas.ts";
import { editedConfig, fixtureCatalog, fixtureConfig, fixtureData, fixtureText, routing as routingOf } from "./helpers.ts";

const routing = fixtureData();
const quota = unknownQuota(routing.config, "test");
const report = (input: Parameters<typeof buildRequest>[0] = {}, selected = routing) => {
  const request = buildRequest(input, selected.config, 0);
  return { request, result: route(request, { routing: selected, catalog: fixtureCatalog, quota }) };
};
const shown = (input: Parameters<typeof buildRequest>[0] = {}, selected = routing) =>
  shownColumns(buildRequest(input, selected.config, 0), selected.config, selected.data);

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
  test("table shows the value, the columns the formulas use, notes and no trailing spaces", () => {
    const { result } = report({ tags: ["review"] });
    const lines = formatRoutes(result.routes, shown());
    expect(lines[0]).toMatch(/^provider\/model\s+effort\s+value\s+quality\s+price\s+spare\s+tags\s+notes$/);
    expect(lines.some((line) => line.includes("missing tags: review"))).toBe(true);
    expect(lines.every((line) => !line.endsWith(" "))).toBe(true);
  });
  test("request description includes job, filters and fallbacks", () => {
    expect(describeRequest(buildRequest({ job: "implement", needs: ["vision"], notModels: ["acme-big"] }, routing.config, 0)))
      .toBe("job implement, score 40-47, tags code, need vision, not model acme-big");
    expect(describeRequest(buildRequest({}, routing.config, 0))).toBe("any request");
    const custom = { value: compile("quality", "number"), where: compile("price < 2", "truth") };
    expect(describeRequest(buildRequest({ score: "40+", ...custom }, routing.config, 0), routing.config)).toBe("score 40+, value quality, where price < 2");
    expect(describeRequest(buildRequest({ score: "40+" }, routing.config, 0), routing.config)).toBe("score 40+");
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
    const rows = formatRoutes(report({ score: "60+" }).result.routes, shown());
    expect(rows.join("\n")).toContain("heavy (max 2)");
    expect(rows.join("\n")).toContain("bounded work only; heavy (max 1)");
    expect(rows.join("\n")).not.toContain("at a time");
  });
  test("shown columns: columns.include and those of the score, cost, value and where, in the data's order", () => {
    const data = fixtureText.replace("quality,price", "quality,price,speed,tokens").split("\n")
      .map((line, i) => (line === "" || i === 0 ? line : `${line},${i},${i * 100}`)).join("\n");
    const config = editedConfig("[formulas]", '[columns]\ninclude = ["tokens"]\n\n[formulas]').replace('value = "-cost"', 'value = "-cost"\nfast = "speed"');
    const selected = routingOf(data, config);
    expect(shown({}, selected)).toEqual({ columns: ["quality", "price", "tokens"], score: false, cost: false });
    expect(shown({ value: compile("fast", "number") }, selected).columns).toEqual(["quality", "price", "speed", "tokens"]);
    expect(shown({ where: compile("speed > 1", "truth") }, selected).columns).toEqual(["quality", "price", "speed", "tokens"]);
    const derived = routingOf(fixtureText, editedConfig('score = "quality"', 'score = "quality * 10"'));
    expect(shown({}, derived)).toEqual({ columns: ["quality", "price"], score: true, cost: false });
    expect(formatRoutes(report({}, derived).result.routes, shown({}, derived))[0]).toMatch(/\bvalue\s+quality\s+price\s+score\s+spare\b/);
  });
});

describe("route output", () => {
  test("text includes counted routes before limit, removed counts, and above-range fallback", () => {
    const { request, result } = report({ score: "40-47", limit: 1 });
    expect(formatText(result, request, quota, routing)).toContain("score 40-47: 6 routes, showing 1; removed 3 below range, 4 above range");
    const above = report({ score: "33-33", limit: 2, everyRoute: true });
    expect(formatText(above.result, above.request, quota, routing)).toContain("none in range, 12 routes, showing 2 above range");
  });
  test("a shortlist of each provider's best route says what it hid, in text, brief and JSON", () => {
    const best = report({ score: "40-47", limit: 2 });
    expect(formatText(best.result, best.request, quota, routing)).toContain(
      "score 40-47: 6 routes, showing 2; 3 other routes of the same providers hidden, --every-route shows them; removed",
    );
    const above = report({ score: "33-33", limit: 2 });
    expect(formatText(above.result, above.request, quota, routing)).toContain(
      "none in range, 12 routes, showing 2 above range; 9 other routes of the same providers hidden, --every-route shows them",
    );
    const brief = formatBrief(best.result, best.request, quota, routing, []);
    expect(brief).toContain("4 more routes, 3 of them other routes of the same providers; pass a larger limit, or 0 for every route.");
    const all = report({ score: "40-47", limit: 3 });
    expect(formatBrief(all.result, all.request, quota, routing, [])).toContain("3 more routes, 3 of them other routes of the same providers; pass limit 0 to see them.");
    const json = jsonReport(best.result, best.request, quota, routing, []);
    expect(json).toMatchObject({ found: { routes: 6, sameProvider: 3 }, request: { limit: 2, everyRoute: false } });
    expect(jsonReport(report({ limit: 2, everyRoute: true }).result, report({ limit: 2, everyRoute: true }).request, quota, routing, [])).toMatchObject({ request: { everyRoute: true } });
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
    expect(brief).toMatch(/anthropic\/acme-big high \(value -5, quality 60, price 5\): heavy/);
    expect(brief).toContain("1 more routes; pass limit to see them.");
    expect(brief).toContain("quota: anthropic spare ?, openai spare ?, github-copilot spare ?");
    expect(brief).toContain("Long-running workers count as heavy too.");
    const bounded = report({ score: "40-40" });
    expect(formatBrief(bounded.result, bounded.request, quota, routing, [])).toContain("Bounded work only");
  });
  test("brief keeps the first route and every note inside the TUI's preview, compacting the metrics", () => {
    const long = (name: string) => `${name}_${"x".repeat(60)}`;
    const data = fixtureText.replace("quality,price", `${long("quality")},${long("price")}`);
    const config = editedConfig('score = "quality"', `score = "${long("quality")}"`).replace('cost = "price"', `cost = "${long("price")}"`)
      .replace('heavy = "score >= 55"', 'heavy = "score >= 50"');
    const selected = routingOf(data, config);
    const request = buildRequest({ score: "50+", tags: ["docs", "fast", "vision"], limit: 1 }, selected.config, 0);
    const result = route(request, { routing: selected, catalog: fixtureCatalog, quota, running: { "github-copilot": 0 } });
    const first = formatBrief(result, request, quota, selected, []).split("\n")[0]!;
    expect(first).toBe("github-copilot/zed-pro xhigh (value -2): heavy, 0 of 1 running on github-copilot; missing tags: docs, fast, vision");
    expect(first.length).toBeLessThanOrEqual(PREVIEW_CHARS);
    const short = report({ score: "60+", limit: 1 });
    expect(formatBrief(short.result, short.request, quota, routing, [])).toContain("(value -5, quality 60, price 5)");
  });
  test("JSON version 3, formulas, shown columns, job, limit, found and null unknown spare", () => {
    const { request, result } = report({ job: "implement", limit: 1 });
    const json = jsonReport(result, request, quota, routing, ["warning"]);
    expect(json).toMatchObject({ version: 3, snapshot: "2000-01-01", columns: { include: [] },
      formulas: { score: "quality", cost: "price", value: "-cost" }, shown: { columns: ["quality", "price"], score: false, cost: false },
      request: { job: "implement", min: 40, max: 47, tags: ["code"], limit: 1, score: "quality", value: "-cost", where: null },
      found: { routes: 6, aboveRange: 0, sameProvider: 0 }, warnings: ["warning"] });
    expect((json.routes as Record<string, unknown>[])[0]).toMatchObject({ spare: null, value: -1, shown: { quality: 45, price: 1 } });
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
      formulas: { score: "quality", cost: "price", value: "-cost" },
      policy: { prefer: ["anthropic", "openai", "github-copilot"], cheap: "cost <= 0.15", heavy: "score >= 55" },
      providers: [{ name: "anthropic", maxHeavy: 2 }, { name: "openai" }, { name: "github-copilot", quotaName: "copilot" }] });
  });
  test("config output reports data path, jobs, aliases and exclusions", () => {
    const sources = { config: { path: fixtureConfig, source: "--config" as const } };
    const text = formatConfig(sources, routing);
    expect(text).toContain("data    ");
    expect(text).toContain("jobs\n");
    expect(text).toContain("github-copilot/acme-big.1");
    expect(text).toContain("formulas\n  score  quality\n  cost   price\n  value  -cost\n");
    expect(text).toContain("  cheap             cost <= 0.15\n  heavy             score >= 55\n");
    expect(jsonConfig(sources, routing)).toMatchObject({ version: 3, data: { rows: 8 }, columns: { include: [] },
      jobs: [{ name: "implement", value: null, where: null }] });
    const job = routingOf(fixtureText, editedConfig('about = "Implement a defined task"', 'about = "Implement a defined task"\nvalue = "quality"\nwhere = "price < 2"'));
    expect(formatConfig(sources, job)).toContain("  implement  40-47 code: Implement a defined task\n             value quality\n             where price < 2\n");
    expect(jsonConfig(sources, job)).toMatchObject({ jobs: [{ name: "implement", value: "quality", where: "price < 2" }] });
    expect(jsonConfig(sources, routing)).toMatchObject({ providers: [{ heavy: null }, { heavy: null }, { heavy: null }] });
    const own = routingOf(fixtureText, editedConfig("[providers.openai]\nmax_heavy = 1", '[providers.openai]\nmax_heavy = 1\nheavy = "cost >= 1"'));
    expect(formatConfig(sources, own)).toContain("openai\n  max_heavy  1\n  heavy      cost >= 1\n");
    expect(jsonConfig(sources, own)).toMatchObject({ providers: [{ heavy: null }, { name: "openai", heavy: "cost >= 1" }, { heavy: null }] });
  });
});
