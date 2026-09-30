import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CatalogError, loadModelsJson, matchModels, offersEffort, parseModelsJson } from "../src/catalog.ts";
import { fixtureCatalog, fixtureData, tempDir, writeFiles } from "./helpers.ts";

describe("catalog", () => {
  test("effort array or object, no effort, vision and none", () => {
    const catalog = parseModelsJson({ p: { models: {
      a: { reasoning_options: [{ type: "effort", values: ["low", "high"] }, { type: "tokens", values: ["max"] }], modalities: { input: ["image"] } },
      b: { reasoning_options: { type: "effort", values: ["medium"] } }, c: {},
    } } }, "test")!;
    expect(catalog.providers.p!.a).toEqual({ efforts: ["low", "high"], vision: true });
    expect(catalog.providers.p!.b!.efforts).toEqual(["medium"]);
    expect(offersEffort(catalog.providers.p!.c!, "none")).toBe(true);
    expect(offersEffort(catalog.providers.p!.c!, "high")).toBe(false);
    expect(parseModelsJson([], "test")).toBeUndefined();
    expect(parseModelsJson({ p: "bad" }, "test")!.providers).toEqual({});
  });
  test("missing or invalid catalog is an error, not unbounded availability", () => {
    const dir = writeFiles(tempDir(), { "invalid.json": "[]", "broken.json": "{" });
    for (const file of ["invalid.json", "broken.json", "missing.json"]) {
      expect(() => loadModelsJson(join(dir, file))).toThrow(CatalogError);
    }
  });
  test("normalized IDs match, exact aliases win even over ambiguity", () => {
    const { config } = fixtureData();
    const catalog = { source: "test", providers: { ...fixtureCatalog.providers,
      openai: { ...fixtureCatalog.providers.openai, "zed.pro": { efforts: ["high"], vision: false } },
    } };
    const matches = matchModels(["zed-pro", "Acme Big"], config, catalog);
    expect(matches.ambiguous).toHaveLength(1);
    expect(matches.ambiguous[0]).toContain("openai/zed-pro and openai/zed.pro");
    expect(matches.byModel.get("acme big")?.["github-copilot"]?.id).toBe("acme-big.1");
    config.models["zed-pro"] = { id: "zed-pro", tags: [], ids: { openai: "zed.pro" } };
    expect(matchModels(["zed-pro"], config, catalog).byModel.get("zed-pro")?.openai?.id).toBe("zed.pro");
  });
  test("normalization equates dot and dash, and missing aliases are diagnosed", () => {
    const { config } = fixtureData();
    const matches = matchModels(["Model.1", "Acme Big"], config, {
      source: "test", providers: { anthropic: { "model-1": { efforts: [], vision: false } }, "github-copilot": {} },
    });
    expect(matches.byModel.get("model-1")?.anthropic?.id).toBe("model-1");
    expect(matches.missingAliases).toContain('model "Acme Big": alias github-copilot/acme-big.1 is not in test');
  });
  test("missing provider/model never matches; a model with no options still offers none effort", () => {
    const { config } = fixtureData();
    const catalog = parseModelsJson({ anthropic: { models: { "empty-model": {} } }, openai: { models: {} } }, "test")!;
    const matches = matchModels(["empty-model", "absent-model"], config, catalog);
    expect(matches.byModel.get("empty-model")?.anthropic?.id).toBe("empty-model");
    expect(matches.byModel.get("absent-model")).toEqual({});
    expect(offersEffort(catalog.providers.anthropic!["empty-model"]!, "none")).toBe(true);
    expect(offersEffort(catalog.providers.anthropic!["empty-model"]!, "high")).toBe(false);
  });
  test("only image input indicates vision; pdf or text do not", () => {
    const catalog = parseModelsJson({ p: { models: {
      image: { modalities: { input: ["text", "image"] } },
      pdf: { modalities: { input: ["pdf", "text"] } }, none: {},
    } } }, "test")!;
    expect(catalog.providers.p!.image!.vision).toBe(true);
    expect(catalog.providers.p!.pdf!.vision).toBe(false);
    expect(catalog.providers.p!.none!.vision).toBe(false);
  });
});
