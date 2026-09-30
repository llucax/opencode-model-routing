import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { checkConfigDir, checkRoutes, checkText, configFiles } from "../src/check.ts";
import { configOnly, fixtureCatalog, fixtureData, fixtureText, routing as parseRouting, tempDir, writeFiles } from "./helpers.ts";

const routing = fixtureData();

describe("catalog checks", () => {
  test("clean data and catalog have no stale references", () => {
    expect(checkRoutes(routing, fixtureCatalog, "config.toml")).toEqual([]);
  });
  test("missing providers, aliases, ambiguous matches and unoffered data models", () => {
    const changed = structuredClone(routing);
    changed.data.rows.push({ model: "zed.pro", vendor: "zed", effort: "high", line: 100, values: { score: 40, cost: 1 } });
    changed.config.providers.ghost = { name: "ghost", boundedOnly: [], maxHeavy: 1, windowOverrides: [] };
    changed.config.models["acme big"]!.ids.anthropic = "gone";
    const catalog = { source: "test", providers: structuredClone(fixtureCatalog.providers) };
    catalog.providers.openai!["zed.pro"] = { efforts: ["high"], vision: false };
    delete catalog.providers["github-copilot"]!["vista-1"];
    const problems = checkRoutes(changed, catalog, "config.toml");
    expect(problems).toContain("config.toml: providers.ghost: not a provider in test");
    expect(problems.some((p) => p.includes("alias anthropic/gone"))).toBe(true);
    expect(problems.some((p) => p.includes("matches openai/zed-pro and openai/zed.pro"))).toBe(true);
    expect(problems.some((p) => p.includes('model "Vista" is offered by none'))).toBe(true);
  });
});

describe("agent config references", () => {
  test("known provider IDs pass; unknown model mentions carry file and line", () => {
    expect(checkText("AGENTS.md", "anthropic/acme-big and github-copilot/acme-big.1", routing, fixtureCatalog)).toEqual([]);
    expect(checkText("AGENTS.md", "Hello\ngithub-copilot/ghost, openai/ghost", routing, fixtureCatalog)).toEqual([
      "AGENTS.md:2: unknown model github-copilot/ghost, which is not a data model's ID there",
      "AGENTS.md:2: unknown model openai/ghost, which is not a data model's ID there",
    ]);
    expect(checkText("file", "https://example.com/openai/ghost and nowhere/ghost", routing, fixtureCatalog)).toEqual([]);
  });
  test("scores are checked with catalog availability; unknown tags and malformed ranges reported", () => {
    expect(checkText("a.md", "--score 40-47 --tags code", routing, fixtureCatalog)).toEqual([]);
    expect(checkText("a.md", "--score 90-99 --tags ghost\n--score 60-40", routing, fixtureCatalog)).toEqual([
      'a.md:1: unknown tag "ghost" in the recommendation for --score 90-99',
      'a.md:1: no route has a score in 90-99, with the provider catalog and the configured providers applied',
      'a.md:2: invalid score range "60-40": the lower bound is above the upper bound',
    ]);
  });
  test("unknown jobs in CLI and tool prose, but known job passes", () => {
    expect(checkText("a.md", '--job implement, job: `implement`, `job: implement`', routing, fixtureCatalog)).toEqual([]);
    expect(checkText("a.md", '--job unknown\njob: `missing`\n`job: absent`', routing, fixtureCatalog)).toEqual([
      'a.md:1: unknown job "unknown"', 'a.md:2: unknown job "missing"', 'a.md:3: unknown job "absent"',
    ]);
  });
  test("checks files from agents, skills, tool instructions and symlinked skills", () => {
    const dir = writeFiles(tempDir(), {
      "AGENTS.md": "--job unknown", "agents/worker.md": "openai/ghost", "skills/local/SKILL.md": "--score 90+",
      "tool-instructions/model-route.md": "--job implement", "ignore.txt": "--job wrong",
    });
    symlinkSync(join(dir, "skills/local"), join(dir, "skills/linked"));
    expect(configFiles(dir)).toHaveLength(5);
    const checked = checkConfigDir(dir, routing, fixtureCatalog);
    expect(checked.files).toBe(5);
    expect(checked.problems).toHaveLength(4);
  });
});

describe("file discovery", () => {
  test("missing folders and non-Markdown files are ignored", () => {
    expect(configFiles(tempDir())).toEqual([]);
    const dir = writeFiles(tempDir(), { "agents/worker.txt": "openai/ghost", "elsewhere/SKILL.md": "x" });
    mkdirSync(join(dir, "skills", "empty"), { recursive: true });
    expect(configFiles(dir)).toEqual([]);
  });
  test("discovers file locations in sorted order", () => {
    const dir = writeFiles(tempDir(), { "AGENTS.md": "x", "agents/z.md": "x", "agents/a.md": "x",
      "skills/first/SKILL.md": "x", "tool-instructions/bash.md": "x" });
    expect(configFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual([
      "AGENTS.md", "agents/a.md", "agents/z.md", "skills/first/SKILL.md", "tool-instructions/bash.md",
    ]);
  });
});

describe("mention scanner details", () => {
  const check = (text: string, selected = routing) => checkText("f.md", text, selected, fixtureCatalog);
  test("model ID must belong to that provider, even if another has it", () => {
    expect(check("openai/acme-big\nanthropic/acme-big.1")).toEqual([
      "f.md:1: unknown model openai/acme-big, which is not a data model's ID there",
      "f.md:2: unknown model anthropic/acme-big.1, which is not a data model's ID there",
    ]);
  });
  test("frontmatter, punctuation, backticks and trailing dots", () => {
    expect(check("---\nmodel: anthropic/acme-gone\n---")).toHaveLength(1);
    expect(check("`anthropic/acme-big`, then anthropic/acme-small.\n(openai/zed-pro)")).toEqual([]);
    expect(check("anthropic/acme-gone.")).toEqual(["f.md:1: unknown model anthropic/acme-gone, which is not a data model's ID there"]);
  });
  test("URLs, local paths, and providers not configured are ignored", () => {
    expect(check("https://github.com/anthropic/acme-gone ./anthropic/acme-gone nowhere/gone")).toEqual([]);
    const only = parseRouting(fixtureText, configOnly("openai"));
    expect(check("anthropic/ghost openai/ghost", only)).toEqual([
      "f.md:1: unknown model openai/ghost, which is not a data model's ID there",
    ]);
  });
  test("all unknown mentions on a line are reported", () => {
    expect(check("anthropic/one anthropic/two")).toHaveLength(2);
  });
});

describe("score recommendation scanner details", () => {
  const check = (text: string, selected = routing, catalog = fixtureCatalog) => checkText("f.md", text, selected, catalog);
  test("known tags, decimal ranges, precise scores and code formatting", () => {
    expect(check("`model-route --score 40-47 --tags code,review`\n--score 60+\n--score 30-30.5")).toEqual([]);
  });
  test("no route meets gaps, or high ranges, and every matching line is reported", () => {
    expect(check("--score 31-34\n--score 90+\nagain --score 90+")).toEqual([
      "f.md:1: no route has a score in 31-34, with the provider catalog and the configured providers applied",
      "f.md:2: no route has a score in 90+, with the provider catalog and the configured providers applied",
      "f.md:3: no route has a score in 90+, with the provider catalog and the configured providers applied",
    ]);
  });
  test("only offered efforts and configured providers count toward a score", () => {
    const catalog = { source: "test", providers: structuredClone(fixtureCatalog.providers) };
    catalog.providers.anthropic!["acme-big"]!.efforts = ["low"];
    catalog.providers["github-copilot"]!["acme-big.1"]!.efforts = ["low"];
    expect(check("--score 60+", routing, catalog)).toHaveLength(1);
    const only = parseRouting(fixtureText, configOnly("openai"));
    expect(check("--score 55+", only)).toHaveLength(1);
    expect(check("--score 40-47", only)).toEqual([]);
  });
  test("tags only count after a score on the same line", () => {
    expect(check("--tags mystery\n--score 40-47\n--tags mystery")).toEqual([]);
    expect(check("--score 40-47 --tags code,mystery")).toEqual([
      'f.md:1: unknown tag "mystery" in the recommendation for --score 40-47',
    ]);
  });
  test("placeholders are not interpreted as range recommendations", () => {
    expect(check("--score RANGE --tags mystery\n--score A-B\n--score <RANGE>")).toEqual([]);
  });
  test("malformed numeric score ranges are diagnosed with line numbers", () => {
    const problems = check("--score 47-40\n--score 40");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toBe('f.md:1: invalid score range "47-40": the lower bound is above the upper bound');
    expect(problems[1]).toStartWith('f.md:2: invalid score range "40": use A-B or A+');
  });
  test("checkConfigDir collates findings in file order", () => {
    const dir = writeFiles(tempDir(), { "AGENTS.md": "anthropic/ghost", "agents/a.md": "openai/ghost" });
    expect(checkConfigDir(dir, routing, fixtureCatalog)).toEqual({ files: 2, problems: [
      `${dir}/AGENTS.md:1: unknown model anthropic/ghost, which is not a data model's ID there`,
      `${dir}/agents/a.md:1: unknown model openai/ghost, which is not a data model's ID there`,
    ] });
  });
});
