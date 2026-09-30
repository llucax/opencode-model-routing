import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { computeQuota, findQuotaCli, loadQuota, monthlyLength, pinnedQuotaVersion, readQuotaJson, spareFor, unknownQuota } from "../src/quota.ts";
import { fixtureData, tempDir, writeFiles } from "./helpers.ts";

const NOW = new Date("2000-01-10T12:00:00Z");
const now = NOW.getTime() / 1000;
const HOUR = 3600;
const DAY = 86400;
const config = fixtureData().config;
const entry = (name: string, percentRemaining: number, resetAt: number, window?: string, renderType = "percent") =>
  ({ name, renderType, percentRemaining, resetAt, ...(window === undefined ? {} : { window }) });
const json = (providers: Record<string, unknown>) => ({ version: 2, providers });

describe("quota windows", () => {
  test("hours, days, weekly, daily, clamping, labels and configured window lengths", () => {
    const entries = [
      entry("Acme 5h", 77, now + 2 * HOUR, "5H"), entry("Three days", 10, now + 1.5 * DAY, "3d"),
      entry("Week", 90, now + 3.5 * DAY, "Weekly"), entry("Day", 50, now + 6 * HOUR, "daily"),
      entry("Far", 60, now + 10 * DAY, "5h"), entry("Past", 60, now - HOUR, "5h"),
      entry("Acme Big Weekly", 100, now + 3.5 * DAY),
    ];
    const quota = computeQuota(json({ anthropic: { status: "ok", entries } }), config, NOW);
    expect(quota.providers.anthropic!.windows.map((w) => w.spare)).toEqual([37, -40, 40, 25, -40, 60, 50]);
    expect(quota.providers.anthropic!.windows.map((w) => w.label)).toEqual(["5h", "3d", "weekly", "daily", "5h", "5h", "Acme Big Weekly"]);
    expect(quota.providers.anthropic!.windows[0]!.secondsToReset).toBe(2 * HOUR);
    expect(quota.providers.anthropic!.windows[5]!.secondsToReset).toBe(0);
  });
  test("unknown window length and invalid entries warn, nonpercent entries ignored", () => {
    const quota = computeQuota(json({ anthropic: { status: "ok", entries: [
      entry("Mystery", 50, now + DAY), entry("Token", 50, now + HOUR, "5h", "value"),
      { name: "Broken", renderType: "percent", resetAt: now, percentRemaining: "half" },
    ] } }), config, NOW);
    expect(quota.warnings).toEqual([
      'quota window "anthropic: Mystery" has no known length; ignored',
      "quota entry in anthropic is malformed; ignored",
    ]);
    expect(quota.providers.anthropic).toEqual({ provider: "anthropic", reason: "no usable quota windows", windows: [] });
  });
  test("calendar months use UTC and the preceding month at the boundary", () => {
    expect(monthlyLength(Date.UTC(2000, 1, 1) / 1000)).toBe(31 * DAY);
    expect(monthlyLength(Date.UTC(2000, 2, 1) / 1000)).toBe(29 * DAY);
    expect(monthlyLength(Date.UTC(2001, 2, 1) / 1000)).toBe(28 * DAY);
    const reset = Date.UTC(2000, 1, 1) / 1000;
    const quota = computeQuota(json({ copilot: { status: "ok", entries: [entry("Premium", 30, reset)] } }), config, NOW);
    expect(quota.providers["github-copilot"]!.windows[0]!.spare).toBeCloseTo(30 - 100 * (reset - now) / (31 * DAY));
  });
  test("quota_name maps providers; unavailable, error and absent quotas keep unknown spare", () => {
    const quota = computeQuota(json({
      anthropic: { status: "error" }, openai: { status: "unavailable" },
      copilot: { status: "ok", entries: [entry("Premium", 20, now + DAY, "daily")] },
      "github-copilot": { status: "ok", entries: [entry("Premium", 99, now + DAY, "daily")] },
    }), config, NOW);
    expect(quota.providers.anthropic!.reason).toBe("quota error");
    expect(quota.providers.openai!.reason).toBe("quota unavailable");
    expect(quota.providers["github-copilot"]!.windows[0]!.percentRemaining).toBe(20);
    expect(Object.keys(computeQuota({}, config, NOW).providers)).toEqual(Object.keys(config.providers));
  });
  test("model-scoped windows match normalized IDs, choose minimum and block before reset", () => {
    const quota = computeQuota(json({ anthropic: { status: "ok", entries: [
      entry("A", 77, now + 2 * HOUR, "5h"), entry("Acme Big Weekly", 0, now + DAY),
    ] } }), config, NOW).providers.anthropic!;
    expect(spareFor(quota, "Acme Big").blocked).toBe(true);
    expect(spareFor(quota, "ACME BIG").spare).toBeLessThan(37);
    expect(spareFor(quota, "Acme Small")).toEqual({ spare: 37, blocked: false });
    expect(spareFor(undefined, "Acme Big")).toEqual({ blocked: false });
    expect(computeQuota(json({ anthropic: { entries: [entry("A", 0, now - 1, "5h")] } }), config, NOW).providers.anthropic!.windows[0]!.blocked).toBe(false);
  });
  test("an entry's own window length overrides configured metadata", () => {
    const entries = [entry("Acme Big Weekly", 100, now + 3.5 * DAY, "7d"), entry("Acme Big Weekly", 100, now + 2 * HOUR, "5h")];
    expect(computeQuota(json({ anthropic: { entries } }), config, NOW).providers.anthropic!.windows.map((w) => w.spare)).toEqual([50, 60]);
  });
  test("windows that aren't percent do not warn or contribute spare", () => {
    const quota = computeQuota(json({ anthropic: { entries: [entry("Tokens", 50, now + HOUR, "5h", "value")] } }), config, NOW);
    expect(quota.warnings).toEqual([]);
    expect(quota.providers.anthropic!.windows).toEqual([]);
  });
  test("zero remaining before reset blocks; zero after reset does not; partial remaining doesn't", () => {
    const entries = [entry("before", 0, now + DAY, "weekly"), entry("after", 0, now - 1, "weekly"),
      entry("partial", 0.5, now + DAY, "weekly")];
    expect(computeQuota(json({ openai: { entries } }), config, NOW).providers.openai!.windows.map((w) => w.blocked)).toEqual([true, false, false]);
  });
  test("configured monthly length can be less than whole month when reset is midmonth", () => {
    expect(monthlyLength(Date.UTC(2000, 1, 6) / 1000)).toBe(5 * DAY);
  });
  test("a provider absent from the quota feed and unrelated providers do not become routes", () => {
    const quota = computeQuota(json({ nowhere: { entries: [entry("A", 50, now + HOUR, "5h")] } }), config, NOW);
    expect(Object.keys(quota.providers)).toEqual(Object.keys(config.providers));
    expect(quota.providers.openai!.reason).toBe("not in the quota data");
    expect(computeQuota("bad", config, NOW).providers.anthropic!.windows).toEqual([]);
  });
  test("a scoped blocked window only blocks its model and computes min spare", () => {
    const quota = computeQuota(json({ anthropic: { entries: [entry("A", 77, now + 2 * HOUR, "5h"),
      entry("Acme Big Weekly", 0, now + DAY)] } }), config, NOW).providers.anthropic!;
    expect(spareFor(quota, "Acme Small")).toEqual({ spare: 37, blocked: false });
    expect(spareFor(quota, "Acme Big").blocked).toBe(true);
  });
  test("no applicable quota windows leave spare unknown", () => {
    expect(spareFor({ provider: "anthropic", windows: [windowFor(["Acme Big"])] }, "Acme Small")).toEqual({ blocked: false });
    expect(spareFor({ provider: "anthropic", windows: [] }, "Acme Big")).toEqual({ blocked: false });
  });
});

function windowFor(models: string[]) {
  return { name: "scope", label: "scope", percentRemaining: 50, secondsToReset: 3600, spare: 10, blocked: false, models };
}

describe("quota input", () => {
  test("reads a saved file asynchronously, warns for missing and malformed files", async () => {
    const dir = writeFiles(tempDir(), { "quota.json": JSON.stringify(json({ openai: { entries: [entry("W", 50, now + DAY, "weekly")] } })), "bad.json": "{" });
    expect((await loadQuota(config, NOW, join(dir, "quota.json"))).providers.openai!.windows).toHaveLength(1);
    expect((await loadQuota(config, NOW, join(dir, "bad.json"))).warnings).toHaveLength(1);
    expect((await loadQuota(config, NOW, join(dir, "missing.json"))).providers.openai!.reason).toBe("quota data unavailable");
    expect((await readQuotaJson(join(dir, "quota.json"))).json).toBeDefined();
    expect(Object.keys(unknownQuota(config, "no data").providers)).toEqual(Object.keys(config.providers));
  });
  const script = (version: string, body: string) => ({
    [`.cache/opencode/packages/@slkiser/opencode-quota@${version}/node_modules/@slkiser/opencode-quota/dist/bin/opencode-quota.js`]: body,
  });
  test("pinned version from JSONC takes priority over the latest installed", async () => {
    const home = writeFiles(tempDir(), {
      ...script("4.9.0", 'console.log("{\\"which\\":\\"4.9.0\\"}");'),
      ...script("4.10.6", 'console.log("{\\"which\\":\\"4.10.6\\"}");'),
      ".config/opencode/opencode.jsonc": '{ "plugin": ["@slkiser/opencode-quota@4.9.0"] }',
    });
    expect(pinnedQuotaVersion(home)).toBe("4.9.0");
    expect(findQuotaCli(home)).toContain("opencode-quota@4.9.0");
    expect(findQuotaCli(home, "not-installed")).toContain("opencode-quota@4.10.6");
    expect((await readQuotaJson(undefined, home)).json).toEqual({ which: "4.9.0" });
  });
  test("reads opencode.json after missing jsonc, ignores plugin without version", () => {
    const home = writeFiles(tempDir(), { ".config/opencode/opencode.json": '{"plugin":["@slkiser/opencode-quota@2.1.0"]}' });
    expect(pinnedQuotaVersion(home)).toBe("2.1.0");
    const without = writeFiles(tempDir(), { ".config/opencode/opencode.json": '{"plugin":["@slkiser/opencode-quota"]}' });
    expect(pinnedQuotaVersion(without)).toBeUndefined();
  });
  test("if no version is pinned, the numerically newest installed CLI wins", async () => {
    const home = writeFiles(tempDir(), {
      ...script("4.9.0", "console.log(JSON.stringify({which: '4.9.0'}));"),
      ...script("4.10.6", "console.log(JSON.stringify({which: '4.10.6'}));"),
      ...script("4.0.1", "console.log(JSON.stringify({which: '4.0.1'}));"),
    });
    expect(findQuotaCli(home)).toContain("opencode-quota@4.10.6");
    expect((await readQuotaJson(undefined, home)).json).toEqual({ which: "4.10.6" });
  });
  test("CLI arguments, failed run, malformed output and absence", async () => {
    const home = writeFiles(tempDir(), script("1.0.0", "console.log(JSON.stringify(process.argv.slice(2)));"));
    expect((await readQuotaJson(undefined, home)).json).toEqual(["show", "--json"]);
    expect((await readQuotaJson(undefined, writeFiles(tempDir(), script("1.0.0", "process.exit(3);")))).reason).toBe("opencode-quota failed with status 3");
    expect((await readQuotaJson(undefined, writeFiles(tempDir(), script("1.0.0", "console.log('bad');")))).reason).toBe("opencode-quota printed invalid JSON");
    expect((await readQuotaJson(undefined, tempDir())).reason).toBe("opencode-quota CLI not found");
  });
});
