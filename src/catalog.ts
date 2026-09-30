// What the providers offer: the model IDs at each provider, their efforts and
// whether they take images. The command line reads OpenCode's models.json
// cache; the tool asks the running OpenCode for its connected providers.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { normalizeId, type Effort } from "./data.ts";
import { show } from "./validate.ts";

export interface CatalogModel {
  /** The efforts (OpenCode variants) the model accepts. */
  efforts: string[];
  vision: boolean;
}

export interface Catalog {
  /** Where the catalog comes from, for messages. */
  source: string;
  /** Provider to model ID to what it offers. */
  providers: Record<string, Record<string, CatalogModel>>;
}

/** Whether a catalog model accepts `effort`: `none` needs no variant, any other must be one. */
export function offersEffort(model: CatalogModel, effort: Effort): boolean {
  return effort === "none" || model.efforts.includes(effort);
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The efforts of a models.json entry; `reasoning_options` is an array or one object. */
function modelsJsonEfforts(model: Obj): string[] {
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [model.reasoning_options];
  const result: string[] = [];
  for (const option of options) {
    if (!isObj(option) || option.type !== "effort" || !Array.isArray(option.values)) continue;
    for (const value of option.values) if (typeof value === "string") result.push(value);
  }
  return result;
}

/** A catalog from parsed models.json content, or undefined if it isn't one. */
export function parseModelsJson(json: unknown, source: string): Catalog | undefined {
  if (!isObj(json)) return undefined;
  const providers: Catalog["providers"] = {};
  for (const [provider, entry] of Object.entries(json)) {
    if (!isObj(entry) || !isObj(entry.models)) continue;
    const models: Record<string, CatalogModel> = {};
    for (const [id, model] of Object.entries(entry.models)) {
      if (!isObj(model)) continue;
      const modalities = isObj(model.modalities) ? model.modalities.input : undefined;
      models[id] = { efforts: modelsJsonEfforts(model), vision: Array.isArray(modalities) && modalities.includes("image") };
    }
    providers[provider] = models;
  }
  return { source, providers };
}

export function defaultModelsJsonPath(): string {
  return join(homedir(), ".cache", "opencode", "models.json");
}

/** Reads the catalog at `path`; a missing or malformed file is an error. */
export function loadModelsJson(path: string): Catalog {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CatalogError(`${path} unreadable (${error instanceof Error ? error.message : String(error)}); without the provider catalog no model can be matched to a provider`);
  }
  const catalog = parseModelsJson(json, path);
  if (!catalog) throw new CatalogError(`${path} is not a provider catalog`);
  return catalog;
}

/** The provider catalog can't be read or is ambiguous. */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

/** Where a data model is at one provider. */
export interface Match {
  /** The model ID at the provider. */
  id: string;
  model: CatalogModel;
}

/** Every data model's IDs at the configured providers, and the problems found. */
export interface Matches {
  /** Normalized data model ID to provider to its match there. */
  byModel: Map<string, Record<string, Match>>;
  /** Aliases pointing at IDs the provider doesn't have. */
  missingAliases: string[];
  /** Data models matching several IDs at one provider. */
  ambiguous: string[];
}

/**
 * Matches the data's models to the configured providers' catalogs. A
 * `[[model]] ids` alias is exact and wins; otherwise a catalog ID matches
 * when it is equal after normalization.
 */
export function matchModels(models: Iterable<string>, config: Config, catalog: Catalog): Matches {
  const normalized = new Map<string, Map<string, string[]>>();
  for (const provider of Object.keys(config.providers)) {
    const byKey = new Map<string, string[]>();
    for (const id of Object.keys(catalog.providers[provider] ?? {})) {
      const key = normalizeId(id);
      byKey.set(key, [...(byKey.get(key) ?? []), id]);
    }
    normalized.set(provider, byKey);
  }

  const byModel = new Map<string, Record<string, Match>>();
  const missingAliases: string[] = [];
  const ambiguous: string[] = [];
  for (const model of models) {
    const key = normalizeId(model);
    const aliases = config.models[key]?.ids ?? {};
    const found: Record<string, Match> = {};
    for (const provider of Object.keys(config.providers)) {
      const offered = catalog.providers[provider] ?? {};
      const alias = aliases[provider];
      if (alias !== undefined) {
        if (offered[alias]) found[provider] = { id: alias, model: offered[alias] };
        else missingAliases.push(`model ${show(model)}: alias ${provider}/${alias} is not in ${catalog.source}`);
        continue;
      }
      const ids = normalized.get(provider)!.get(key) ?? [];
      if (ids.length > 1) {
        ambiguous.push(
          `model ${show(model)} matches ${ids.map((id) => `${provider}/${id}`).join(" and ")}; set one with ids = { ${provider} = "..." } in its [[model]]`,
        );
      } else if (ids.length === 1) found[provider] = { id: ids[0]!, model: offered[ids[0]!]! };
    }
    byModel.set(key, found);
  }
  return { byModel, missingAliases, ambiguous };
}
