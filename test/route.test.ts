import { describe, expect, test } from "bun:test";
import { CatalogError } from "../src/catalog.ts";
import { computeQuota, unknownQuota, type WindowState } from "../src/quota.ts";
import { buildRequest, describeJobs, parseRange, splitList, UsageError } from "../src/request.ts";
import { resolveNotModel, route, type Route, type RouteInputs } from "../src/route.ts";
import { matchModels } from "../src/catalog.ts";
import { configOnly, editedConfig, fixtureCatalog, fixtureConfigText, fixtureData, fixtureText, routeFixture, routing } from "./helpers.ts";

const names = (routes: Route[]) => routes.map((r) => `${r.provider}/${r.modelId} ${r.effort}`);
const req = (input: Parameters<typeof buildRequest>[0] = {}, selected = fixtureData()) => buildRequest(input, selected.config, 0);
const window = (spare: number, fields: Partial<WindowState> = {}): WindowState =>
  ({ name: "w", label: "w", percentRemaining: 50, secondsToReset: 3600, spare, blocked: false, ...fields });
function withWindows(windows: Record<string, WindowState[]>, selected = fixtureData()): RouteInputs {
  const quota = unknownQuota(selected.config, "test");
  for (const [provider, value] of Object.entries(windows)) quota.providers[provider] = { provider, windows: value };
  return { routing: selected, catalog: fixtureCatalog, quota };
}

describe("requests", () => {
  test("parses inclusive decimal score ranges, lists and rejects invalid ranges", () => {
    expect(parseRange("40.5-47.2")).toEqual({ min: 40.5, max: 47.2 });
    expect(parseRange("60+")).toEqual({ min: 60 });
    expect(splitList(["code, review", "", "docs"])).toEqual(["code", "review", "docs"]);
    for (const value of ["47-40", "-1+", "bad"]) expect(() => parseRange(value)).toThrow(UsageError);
  });
  test("jobs supply score and tags, explicit score or even empty tags replace them", () => {
    expect(req({ job: "implement" })).toMatchObject({ job: "implement", min: 40, max: 47, tags: ["code"], limit: 0 });
    expect(req({ job: "implement", score: "50+", tags: [] })).toMatchObject({ min: 50, tags: [] });
    expect(req({ job: "implement", score: "50+", tags: [] }).max).toBeUndefined();
    expect(req({ job: "implement", tags: ["review", "review"], limit: 2 }).tags).toEqual(["review"]);
    expect(describeJobs(fixtureData().config)).toContain("  implement  40-47 code: Implement a defined task");
  });
  test("unknown jobs, tags and needs explain available choices", () => {
    expect(() => req({ job: "unknown" })).toThrow(/unknown job "unknown"; the jobs are:\n  implement/);
    expect(() => req({ tags: ["unknown"] })).toThrow(/unknown tag "unknown"; the known tags are:/);
    expect(() => req({ needs: ["audio"] })).toThrow('unknown need "audio"; the known needs are: vision');
    expect(() => req({ limit: -1 })).toThrow(UsageError);
    expect(() => req({ limit: 1.1 })).toThrow(UsageError);
    expect(req({ limit: 0 }).limit).toBe(0);
  });
});

describe("candidate selection and ranking", () => {
  test("every configured and offered model/effort, unknown quota ranks by cost and score", () => {
    const result = routeFixture();
    expect(names(result.routes)).toEqual([
      "github-copilot/zed-lite medium", "openai/zed-lite medium", "anthropic/acme-small low",
      "github-copilot/vista-1 medium", "anthropic/acme-small high", "anthropic/acme-big low",
      "github-copilot/acme-big.1 low", "github-copilot/zed-pro high", "openai/zed-pro high",
      "github-copilot/zed-pro xhigh", "openai/zed-pro xhigh", "anthropic/acme-big high",
      "github-copilot/acme-big.1 high",
    ]);
    expect(result.found).toEqual({ routes: 13, aboveRange: 0 });
    expect(Object.values(result.removed).every((count) => count === 0)).toBe(true);
  });
  test("ties are deterministic regardless of CSV order", () => {
    const selected = fixtureData();
    const first = names(routeFixture().routes);
    selected.data.rows.reverse();
    expect(names(routeFixture({}, { routing: selected }).routes)).toEqual(first);
  });
  test("route carries the data, aliases, tags, derived bounds and notes", () => {
    const result = routeFixture({ tags: ["review", "docs"] });
    const selected = result.routes.find((r) => r.provider === "github-copilot" && r.modelId === "acme-big.1" && r.effort === "low")!;
    expect(selected).toMatchObject({ model: "Acme Big", vendor: "acme", values: { score: 40, cost: 1 },
      score: 40, cost: 1, bounded: true, heavy: false, maxHeavy: 1, matchedTags: ["review"], missingTags: ["docs"] });
    expect(selected.notes).toEqual(["bounded work only", "missing tags: docs"]);
  });
  test("unmatched rows count once, not for every provider", () => {
    const only = routing(fixtureText, configOnly("github-copilot"));
    const result = routeFixture({}, { routing: only });
    expect(result.routes).toHaveLength(6);
    expect(result.removed.noProvider).toBe(2); // Acme Small's two data rows have no provider.
    expect(result.routes.every((r) => r.provider === "github-copilot")).toBe(true);
  });
  test("quota groups: preferred, low spare, unknown, cheap and tags", () => {
    const baseline = route(req({ tags: ["review", "code"] }), withWindows({
      anthropic: [window(15)], openai: [window(50)], "github-copilot": [window(-20)],
    }));
    expect(baseline.routes[0]!.provider).toBe("anthropic");
    expect(baseline.routes.filter((r) => r.provider === "github-copilot").at(-1)!.spare).toBe(-20);
    expect(baseline.routes.find((r) => r.model === "Acme Small")!.notes).toContain("missing tags: review");
    expect(route(req(), withWindows({ anthropic: [window(-8)], openai: [window(30)] })).routes[0]!.provider).toBe("openai");
  });
});

describe("filters and fallback", () => {
  test("bounds are inclusive, below removed, above set aside if anything is in range", () => {
    const result = routeFixture({ score: "40-47" });
    expect(new Set(result.routes.map((r) => r.score))).toEqual(new Set([40, 45, 47]));
    expect(result.found).toEqual({ routes: 6, aboveRange: 0 });
    expect(result.removed).toMatchObject({ belowRange: 3, aboveRange: 4 });
  });
  test("above-range fallback and nearest after every route is below", () => {
    const above = routeFixture({ score: "33-33", limit: 2 });
    expect(above.aboveRange).toHaveLength(2);
    expect(above.found.aboveRange).toBe(12);
    expect(above.aboveRange.every((r) => r.notes[0] === "above range")).toBe(true);
    const below = routeFixture({ score: "100+" });
    expect(below.routes).toEqual([]);
    expect(below.aboveRange).toEqual([]);
    expect(below.removed.belowRange).toBe(13);
    expect(below.nearest[0]!.why).toContain("below range");
  });
  test("limit slices after ranking and reports counts before the slice", () => {
    const full = routeFixture({ score: "40-47" });
    const limited = routeFixture({ score: "40-47", limit: 1 });
    expect(limited.routes).toEqual(full.routes.slice(0, 1));
    expect(limited.found).toEqual(full.found);
    expect(routeFixture({ score: "40-47", limit: 0 }).routes).toHaveLength(6);
  });
  test("tags are soft; capability filters by catalog vision", () => {
    const tags = routeFixture({ tags: ["review", "code"] });
    expect(tags.routes[0]!.matchedTags).toHaveLength(2);
    expect(tags.routes).toHaveLength(13);
    const vision = routeFixture({ needs: ["vision"] });
    expect(names(vision.routes)).toEqual(["github-copilot/vista-1 medium"]);
    expect(vision.removed.needs).toBe(12);
  });
  test("notModels matches data and provider-qualified aliases; other vendors rank before avoided vendor", () => {
    const result = routeFixture({ notModels: ["github-copilot/acme-big.1"] });
    expect(result.removed.sameModel).toBe(4);
    expect(result.routes.every((r) => r.model !== "Acme Big")).toBe(true);
    expect(result.routes.slice(0, 3).every((r) => r.vendor !== "acme")).toBe(true);
    expect(routeFixture({ notModels: ["ghost"] }).warnings).toEqual(['not_model "ghost" matches no model in the data']);
    const models = ["Acme Big"];
    const matches = matchModels(models, fixtureData().config, fixtureCatalog);
    expect(resolveNotModel("acme-big.1", models, matches.byModel)).toEqual(["acme big"]);
  });
  test("all-model and effort exclusions apply before effort availability", () => {
    const selected = routing(fixtureText, `${editedConfig('bounded_only = ["Acme Big"]', 'bounded_only = ["Acme Big"]')}\n[[exclude]]\nmodel = "Acme Small"\nreason = "old"\n[[exclude]]\nmodel = "Zed Pro"\neffort = "high"\nreason = "slow"\n`);
    const result = routeFixture({}, { routing: selected });
    expect(result.removed.excluded).toBe(4);
    expect(result.excluded).toHaveLength(2);
    expect(names(result.routes)).not.toContain("openai/zed-pro high");
  });
  test("unoffered efforts count, and none is offered even without variants", () => {
    const catalog = { source: "test", providers: structuredClone(fixtureCatalog.providers) };
    catalog.providers.anthropic!["acme-big"]!.efforts = ["high"];
    const selected = routing(`${fixtureText}Zed Lite,zed,none,2000-01-03,32,0.1\n`);
    const result = routeFixture({}, { routing: selected, catalog });
    expect(result.removed.notOffered).toBe(1);
    expect(names(result.routes)).toContain("openai/zed-lite none");
  });
  test("running heavy sessions enforce max_heavy only when running is known", () => {
    expect(routeFixture().routes.some((r) => r.provider === "anthropic" && r.heavy)).toBe(true);
    const result = routeFixture({}, { running: { anthropic: 2, "github-copilot": 1 } });
    expect(result.removed.heavyLimit).toBe(2);
    expect(result.routes.every((r) => !r.heavy)).toBe(true);
    expect(result.routes.find((r) => r.provider === "anthropic")!.running).toBe(2);
  });
  test("blocked model-specific quotas remove only their applicable routes", () => {
    const selected = fixtureData();
    const quota = computeQuota({ providers: { anthropic: { entries: [{ name: "Acme Big Weekly", renderType: "percent", percentRemaining: 0,
      resetAt: new Date("2000-01-12").getTime() / 1000 }] } } }, selected.config, new Date("2000-01-10"));
    const result = route(req({}, selected), { routing: selected, catalog: fixtureCatalog, quota });
    expect(result.removed.exhausted).toBe(2);
    expect(result.routes.some((r) => r.model === "Acme Small")).toBe(true);
  });
  test("ambiguous catalog IDs fail routing rather than guess", () => {
    const catalog = { source: "test", providers: structuredClone(fixtureCatalog.providers) };
    catalog.providers.openai!["zed.pro"] = { efforts: ["high"], vision: false };
    const selected = routing(`${fixtureText}zed.pro,zed,high,2000-01-03,43,1\n`);
    expect(() => routeFixture({}, { catalog, routing: selected })).toThrow(CatalogError);
  });
});

describe("provider standing", () => {
  const ranked = (windows: Record<string, WindowState[]>, text = fixtureText, configText = editedConfig("cheap_cost = 0.15", "cheap_cost = 0")) => {
    const selected = routing(text, configText);
    return route(req({}, selected), withWindows(windows, selected)).routes;
  };
  test("providers with enough spare go by configured preference before cost", () => {
    expect([...new Set(ranked({ anthropic: [window(5)], openai: [window(50)], "github-copilot": [window(90)] }).map((r) => r.provider))]).toEqual([
      "anthropic", "openai", "github-copilot",
    ]);
  });
  test("inclusive threshold; below threshold spare determines standing", () => {
    expect(ranked({ anthropic: [window(-10)], openai: [window(-10.5)] })[0]!.provider).toBe("anthropic");
    expect(ranked({ anthropic: [window(-10.5)], openai: [window(-10)], "github-copilot": [window(-30)] })[0]!.provider).toBe("openai");
  });
  test("poor spare rounds to steps; ties are decided by cost", () => {
    const result = ranked({ anthropic: [window(-15)], openai: [window(-25)], "github-copilot": [window(-12)] });
    expect(result.at(-1)!.provider).toBe("openai");
    expect(names(result)[0]).toBe("github-copilot/zed-lite medium");
  });
  test("known spare precedes unknown; well-off before low spare", () => {
    expect([...new Set(ranked({ anthropic: [window(-40)], "github-copilot": [window(30)] }).map((r) => r.provider))]).toEqual([
      "github-copilot", "anthropic", "openai",
    ]);
  });
  test("unlisted providers stand behind listed providers", () => {
    const text = editedConfig('prefer = ["anthropic", "openai", "github-copilot"]', 'prefer = ["openai"]')
      .replace("cheap_cost = 0.15", "cheap_cost = 0");
    const providers = ranked({ anthropic: [window(5)], openai: [window(5)], "github-copilot": [window(5)] }, fixtureText, text).map((r) => r.provider);
    expect(providers.slice(0, 3)).toEqual(["openai", "openai", "openai"]);
    expect(providers.slice(3)).not.toContain("openai");
  });
  test("model-scoped window changes only its model's rank and spare", () => {
    const result = ranked({ anthropic: [window(30), window(-50, { models: ["Acme Big"] })] });
    const big = result.find((r) => r.model === "Acme Big" && r.provider === "anthropic")!;
    const small = result.find((r) => r.model === "Acme Small")!;
    expect(big.spare).toBe(-50);
    expect(small.spare).toBe(30);
    expect(result.indexOf(small)).toBeLessThan(result.indexOf(big));
  });
});

describe("cheap ranking", () => {
  const rich = { anthropic: [window(50)], openai: [window(50)], "github-copilot": [window(50)] };
  test("cheap routes precede preferred providers when they have enough spare", () => {
    expect(names(route(req(), withWindows(rich)).routes).slice(0, 3)).toEqual([
      "openai/zed-lite medium", "github-copilot/zed-lite medium", "anthropic/acme-small low",
    ]);
  });
  test("cheapness never outranks a requested missing tag", () => {
    expect(names(route(req({ tags: ["docs"] }), withWindows(rich)).routes)[0]).toBe("anthropic/acme-small low");
    expect(names(route(req({ tags: ["fast"] }), withWindows(rich)).routes)[0]).toBe("openai/zed-lite medium");
  });
  test("cheap-cost boundary is inclusive", () => {
    const selected = routing(fixtureText, editedConfig("cheap_cost = 0.15", "cheap_cost = 0.2"));
    expect(names(route(req({}, selected), withWindows(rich, selected)).routes).slice(0, 3)).toEqual([
      "anthropic/acme-small low", "openai/zed-lite medium", "github-copilot/zed-lite medium",
    ]);
  });
  test("unknown and below-threshold spare do not qualify as cheap", () => {
    expect(names(routeFixture().routes)[0]).toBe("github-copilot/zed-lite medium");
    const result = route(req(), withWindows({ anthropic: [window(50)], openai: [window(-20)], "github-copilot": [window(-20)] }));
    expect(names(result.routes)[0]).toBe("anthropic/acme-small low");
  });
  test("a broad cheap boundary groups routes first, ordered by provider then cost", () => {
    const selected = routing(fixtureText, editedConfig("cheap_cost = 0.15", "cheap_cost = 1.0"));
    const result = route(req({}, selected), withWindows(rich, selected)).routes;
    const cheap = result.filter((r) => r.cost <= 1).length;
    expect(result.slice(0, cheap).every((r) => r.cost <= 1)).toBe(true);
    expect(names(result).slice(0, 4)).toEqual([
      "anthropic/acme-small low", "anthropic/acme-small high", "anthropic/acme-big low", "openai/zed-lite medium",
    ]);
  });
});

describe("routing detail", () => {
  test("one vendor is preferred over cost and score after not-model", () => {
    const models = routeFixture({ notModels: ["acme-big"] }).routes.map((r) => r.model);
    expect(models.lastIndexOf("Zed Pro")).toBeLessThan(models.indexOf("Acme Small"));
    expect(models.lastIndexOf("Vista")).toBeLessThan(models.indexOf("Acme Small"));
  });
  test("several avoided models prefer the remaining vendor", () => {
    const result = routeFixture({ notModels: ["acme-big", "zed-lite"] });
    expect(result.routes[0]!.model).toBe("Vista");
    expect(result.removed.sameModel).toBe(6);
  });
  test("not-model accepts case, aliases and any prefix for a data ID", () => {
    for (const id of ["Acme Big", "acme big", "anthropic/acme-big", "github-copilot/acme-big.1", "ACME-BIG.1", "ghost/Acme Big"]) {
      const result = routeFixture({ notModels: [id] });
      expect(result.removed.sameModel).toBe(4);
      expect(result.warnings).toEqual([]);
    }
  });
  test("a nonmatching not-model leaves the same rankings", () => {
    const result = routeFixture({ notModels: ["mystery-9"] });
    expect(names(result.routes)).toEqual(names(routeFixture().routes));
    expect(result.warnings).toHaveLength(1);
  });
  test("only a maximum includes matching lower scores; only a minimum includes higher", () => {
    expect(new Set(routeFixture({ score: "50+" }).routes.map((r) => r.score))).toEqual(new Set([50, 60]));
    expect(new Set(route(req({}), withWindows({})).routes.map((r) => r.score)).has(35)).toBe(true);
    const upper = route({ ...req(), max: 35 }, withWindows({}));
    expect(new Set(upper.routes.map((r) => r.score))).toEqual(new Set([30, 35]));
  });
  test("all candidates blocked are nearest, with exhaustion and distance", () => {
    const blocked = { anthropic: [window(-100, { blocked: true })], openai: [window(-100, { blocked: true })],
      "github-copilot": [window(-100, { blocked: true })] };
    const result = route(req({ score: "100+" }), withWindows(blocked));
    expect(result.removed.exhausted).toBe(13);
    expect(names(result.nearest)).toEqual(["anthropic/acme-big high", "github-copilot/acme-big.1 high", "github-copilot/zed-pro xhigh"]);
    expect(result.nearest.map((r) => r.why)).toEqual([
      "exhausted, below range by 40", "exhausted, below range by 40", "exhausted, below range by 50",
    ]);
  });
  test("blocked in-range nearest only says exhausted", () => {
    const result = route(req({ score: "55-65" }), withWindows({
      anthropic: [window(-100, { blocked: true })], "github-copilot": [window(-100, { blocked: true })],
    }));
    expect(result.routes).toEqual([]);
    expect(result.nearest[0]).toMatchObject({ model: "Acme Big", effort: "high", why: "exhausted" });
  });
  test("exclusion, not-offered, need and avoided-model removals cannot enter nearest", () => {
    const selected = routing(fixtureText, `${fixtureConfigText}\n[[exclude]]\nmodel = "Zed Pro"\neffort = "xhigh"\nreason = "no"\n`);
    const result = route(req({ score: "100+", notModels: ["Acme Big"], needs: ["vision"] }, selected), {
      routing: selected, catalog: fixtureCatalog, quota: unknownQuota(selected.config, "test"),
    });
    expect(result.nearest.map((r) => r.model)).toEqual(["Vista"]);
  });
  test("avoiding every data model leaves no nearest result", () => {
    const result = routeFixture({ notModels: ["acme-big", "acme-small", "zed-pro", "zed-lite", "vista-1"] });
    expect(result.routes).toEqual([]);
    expect(result.nearest).toEqual([]);
    expect(result.removed.sameModel).toBe(13);
  });
  test("bounded-above cost adds a note without altering rank; equality is not bounded", () => {
    const base = names(routeFixture().routes);
    const selected = routing(fixtureText, editedConfig("[providers.openai]\nmax_heavy = 1", "[providers.openai]\nmax_heavy = 1\nbounded_above_cost = 1.5"));
    const routes = routeFixture({}, { routing: selected }).routes;
    expect(names(routes)).toEqual(base);
    expect(routes.filter((r) => r.provider === "openai" && r.bounded).map((r) => r.cost)).toEqual([2]);
    expect(routes.find((r) => r.provider === "openai" && r.cost === 1.5)!.bounded).toBe(false);
    expect(routes.find((r) => r.provider === "openai" && r.cost === 2)!.notes).toContain("bounded work only");
  });
  test("heavy threshold is inclusive and changes only notes, not ranking", () => {
    const base = routeFixture().routes;
    expect(base.filter((r) => r.heavy).map((r) => r.score)).toEqual([60, 60]);
    expect(base.find((r) => r.provider === "anthropic" && r.heavy)!.notes).toEqual(["heavy, at most 2 at a time on anthropic"]);
    const edge = routing(fixtureText, editedConfig("heavy_score = 55", "heavy_score = 50"));
    expect(new Set(routeFixture({}, { routing: edge }).routes.filter((r) => r.heavy).map((r) => r.score))).toEqual(new Set([50, 60]));
    const off = routing(fixtureText, editedConfig("heavy_score = 55", "heavy_score = 1000"));
    expect(names(routeFixture({}, { routing: off }).routes)).toEqual(names(base));
  });
  test("known running count is included in heavy notes; heavy limit makes nearest candidates", () => {
    const result = routeFixture({ score: "60+" }, { running: { anthropic: 2, "github-copilot": 1 } });
    expect(result.removed.heavyLimit).toBe(2);
    expect(result.nearest[0]!.why).toContain("heavy running");
    const one = routeFixture({ score: "60+" }, { running: { anthropic: 1 } });
    expect(one.routes[0]!.notes).toContain("heavy, 1 of 2 running on anthropic");
  });
  test("only exclusions that hit offered candidate models are reported", () => {
    const selected = routing(fixtureText, `${fixtureConfigText}\n[[exclude]]\nmodel = "Zed Pro"\neffort = "high"\nreason = "too slow"\n[[exclude]]\nmodel = "Vista"\nreason = "unused"\n`);
    const result = routeFixture({}, { routing: selected });
    expect(result.excluded).toEqual([{ model: "Zed Pro", effort: "high", reason: "too slow" }, { model: "Vista", reason: "unused" }]);
    expect(result.removed.excluded).toBe(3);
    expect(routeFixture().excluded).toEqual([]);
    const only = routing(fixtureText, configOnly("anthropic") + '\n[[exclude]]\nmodel = "Vista"\nreason = "not available"\n');
    expect(routeFixture({}, { routing: only }).excluded).toEqual([]);
  });
  test("configured providers alone produce candidates and nearest routes", () => {
    const selected = routing(fixtureText, configOnly("openai"));
    const below = routeFixture({ score: "100+" }, { routing: selected });
    expect(below.removed.noProvider).toBe(5);
    expect(below.nearest).toHaveLength(3);
    expect(below.nearest.every((r) => r.provider === "openai")).toBe(true);
  });
  test("blocked provider routes are all removed while other providers survive", () => {
    const result = route(req(), withWindows({ anthropic: [window(-100, { blocked: true })] }));
    expect(result.removed.exhausted).toBe(4);
    expect(result.routes.some((r) => r.provider === "anthropic")).toBe(false);
    expect(result.routes).toHaveLength(9);
  });
  test("effort filtering counts each unavailable provider route after exclusions", () => {
    const catalog = { source: "test", providers: structuredClone(fixtureCatalog.providers) };
    catalog.providers.anthropic!["acme-big"]!.efforts = [];
    catalog.providers.openai!["zed-lite"]!.efforts = [];
    expect(routeFixture({}, { catalog }).removed.notOffered).toBe(3);
  });
  test("filter counters follow exclusion, unoffered, needs, avoidance, heavy, quota and range order", () => {
    const selected = routing(fixtureText, `${fixtureConfigText}\n[[exclude]]\nmodel = "Vista"\nreason = "excluded"\n`);
    const catalog = { source: "test", providers: structuredClone(fixtureCatalog.providers) };
    catalog.providers.anthropic!["acme-small"]!.efforts = ["high"];
    const request = req({ needs: ["vision"], notModels: ["Acme Big"], score: "100+" }, selected);
    const result = route(request, { routing: selected, catalog, quota: unknownQuota(selected.config, "test"),
      running: { anthropic: 2, openai: 1, "github-copilot": 1 } });
    expect(result.removed.excluded).toBe(1);
    expect(result.removed.notOffered).toBe(1);
    expect(result.removed.needs).toBe(11);
    expect(result.removed.sameModel).toBe(0);
    expect(result.removed.heavyLimit).toBe(0);
    expect(result.removed.exhausted).toBe(0);
    expect(result.removed.belowRange).toBe(0);
    expect(result.nearest).toEqual([]);
  });
  test("a bounded model on an unconfigured provider is not excluded in the result", () => {
    const only = routing(fixtureText, configOnly("github-copilot") + '\n[[exclude]]\nmodel = "Acme Small"\nreason = "no match"\n');
    const result = routeFixture({}, { routing: only });
    expect(result.removed.excluded).toBe(0);
    expect(result.excluded).toEqual([]);
  });
});
