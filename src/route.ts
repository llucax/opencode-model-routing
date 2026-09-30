// The routing core: from a request, the configuration and its data, the
// provider catalog, the quota and optionally the running heavy sessions, the
// ranked routes. Pure and deterministic: everything comes in as an argument.

import { CatalogError, matchModels, offersEffort, type Catalog, type Match } from "./catalog.ts";
import type { Exclusion, Routing } from "./config.ts";
import { dataModels, normalizeId, type Effort } from "./data.ts";
import { spareFor, type Quota } from "./quota.ts";
import type { Request } from "./request.ts";

export interface Route {
  provider: string;
  /** The model's ID at the provider. */
  modelId: string;
  /** The model's ID in the data. */
  model: string;
  vendor: string;
  effort: Effort;
  /** The value of `columns.score`. */
  score: number;
  /** The value of `columns.cost`. */
  cost: number;
  /** Every used column's value. */
  values: Record<string, number>;
  /** The model's tags from the configuration. */
  modelTags: string[];
  bounded: boolean;
  /** Scores at least the policy's heavy_score. */
  heavy: boolean;
  /** How many heavy sessions may run at once on the provider. */
  maxHeavy: number;
  /** Heavy sessions running on the provider, when known. */
  running?: number;
  /** Undefined when unknown. */
  spare?: number;
  blocked: boolean;
  matchedTags: string[];
  missingTags: string[];
  notes: string[];
}

/** A route that is out, and why. */
export interface Nearest extends Route {
  why: string;
}

/** How many routes each filter removed. */
export interface Removed {
  /** Data rows whose model none of the configured providers has. */
  noProvider: number;
  excluded: number;
  /** Routes whose effort the provider doesn't offer for the model. */
  notOffered: number;
  needs: number;
  sameModel: number;
  /** Heavy routes of a provider already running its max_heavy. */
  heavyLimit: number;
  exhausted: number;
  belowRange: number;
  aboveRange: number;
}

export interface RouteResult {
  /** Routes in range, best first, cut to the request's limit. */
  routes: Route[];
  /** When nothing is in range, the routes above it, best first, cut to the limit. */
  aboveRange: Route[];
  /** How many routes were found before the limit, in range and above it. */
  found: { routes: number; aboveRange: number };
  removed: Removed;
  /** The exclusions that removed at least one route, with their reasons. */
  excluded: Exclusion[];
  /** When there is nothing at all, up to three routes that came closest. */
  nearest: Nearest[];
  warnings: string[];
}

export interface RouteInputs {
  routing: Routing;
  catalog: Catalog;
  quota: Quota;
  /** Heavy sessions running per provider; without it, limits aren't applied. */
  running?: Record<string, number>;
}

export const MAX_NEAREST = 3;

/** How far `score` is from the range, negative below it and positive above it; 0 inside. */
function distance(score: number, request: Request): number {
  if (request.min !== undefined && score < request.min) return score - request.min;
  if (request.max !== undefined && score > request.max) return score - request.max;
  return 0;
}

/**
 * The data models a `not_model` value refers to, by normalized ID: a data ID,
 * or an ID at a provider with or without its `provider/` prefix. A data ID
 * after any prefix counts too, even a provider that isn't configured: the
 * author of the work under review may have run anywhere, and avoiding its
 * model is the point.
 */
export function resolveNotModel(value: string, models: Iterable<string>, matches: Map<string, Record<string, Match>>): string[] {
  const slash = value.indexOf("/");
  const prefix = slash === -1 ? undefined : value.slice(0, slash);
  const rest = normalizeId(value.slice(slash + 1));
  const whole = normalizeId(value);
  const found: string[] = [];
  for (const model of models) {
    const key = normalizeId(model);
    const atProviders = Object.entries(matches.get(key) ?? {}).some(
      ([provider, match]) => (prefix === undefined || provider === prefix) && normalizeId(match.id) === rest,
    );
    if (key === whole || key === rest || atProviders) found.push(key);
  }
  return found;
}

function routeName(route: Route): string {
  return `${route.provider}/${route.modelId} ${route.effort}`;
}

function compareKeys(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left === right) continue;
    if (typeof left === "string" || typeof right === "string") return String(left) < String(right) ? -1 : 1;
    return left - right;
  }
  return 0;
}

/** The ascending sort key of a route. */
function rankKey(route: Route, routing: Routing, avoidedVendors: Set<string> | undefined): (number | string)[] {
  const { prefer, preferMinSpare, spareStep, cheapCost } = routing.config.policy;
  let group: number;
  let position: number;
  let cheap = 0;
  if (route.spare === undefined) {
    group = 2;
    position = 0;
  } else if (route.spare >= preferMinSpare) {
    const index = prefer.indexOf(route.provider);
    group = 0;
    position = index === -1 ? prefer.length : index;
    // Cheap only with every requested tag: cheapness must not beat a tag the
    // job asked for.
    if (route.cost > cheapCost || route.missingTags.length > 0) cheap = 1;
  } else {
    group = 1;
    position = -Math.floor(route.spare / spareStep);
  }
  return [
    avoidedVendors === undefined ? 0 : avoidedVendors.has(route.vendor) ? 1 : 0,
    group,
    cheap,
    position,
    -route.matchedTags.length,
    route.cost,
    -route.score,
    routeName(route),
  ];
}

function atHeavyLimit(route: Route): boolean {
  return route.heavy && route.running !== undefined && route.running >= route.maxHeavy;
}

function notesFor(route: Route, aboveRange: boolean): string[] {
  const notes: string[] = [];
  if (aboveRange) notes.push("above range");
  if (route.bounded) notes.push("bounded work only");
  if (route.heavy) {
    notes.push(
      route.running === undefined
        ? `heavy, at most ${route.maxHeavy} at a time on ${route.provider}`
        : `heavy, ${route.running} of ${route.maxHeavy} running on ${route.provider}`,
    );
  }
  if (route.missingTags.length > 0) notes.push(`missing tags: ${route.missingTags.join(", ")}`);
  return notes;
}

/** Why a route that passed the first filters is out of the result. */
function whyOut(route: Route, request: Request): string {
  const reasons: string[] = [];
  if (atHeavyLimit(route)) reasons.push(`${route.running} of ${route.maxHeavy} heavy running on ${route.provider}`);
  if (route.blocked) reasons.push("exhausted");
  const away = Number(distance(route.score, request).toFixed(2));
  if (away < 0) reasons.push(`below range by ${-away}`);
  if (away > 0) reasons.push(`above range by ${away}`);
  return reasons.join(", ");
}

export function route(request: Request, inputs: RouteInputs): RouteResult {
  const { routing, catalog, quota, running } = inputs;
  const { config, data } = routing;
  const warnings: string[] = [];
  const removed: Removed = {
    noProvider: 0,
    excluded: 0,
    notOffered: 0,
    needs: 0,
    sameModel: 0,
    heavyLimit: 0,
    exhausted: 0,
    belowRange: 0,
    aboveRange: 0,
  };

  const models = dataModels(data);
  const matches = matchModels(
    [...models.values()].map((entry) => entry.model),
    config,
    catalog,
  );
  if (matches.ambiguous.length > 0) throw new CatalogError(matches.ambiguous.join("\n"));
  warnings.push(...matches.missingAliases);

  const avoided = new Set<string>();
  for (const value of request.notModels) {
    const found = resolveNotModel(value, [...models.values()].map((entry) => entry.model), matches.byModel);
    if (found.length === 0) warnings.push(`not_model "${value}" matches no model in the data`);
    for (const key of found) avoided.add(key);
  }
  const avoidedVendors =
    request.notModels.length > 0 ? new Set([...avoided].map((key) => models.get(key)!.vendor)) : undefined;

  // Candidates: every row at every configured provider that has its model.
  const all: (Route & { offered: boolean; vision: boolean; key: string })[] = [];
  for (const row of data.rows) {
    const key = normalizeId(row.model);
    const found = matches.byModel.get(key) ?? {};
    if (Object.keys(found).length === 0) {
      removed.noProvider++;
      continue;
    }
    const entry = config.models[key];
    const modelTags = entry?.tags ?? [];
    const score = row.values[config.columns.score]!;
    const cost = row.values[config.columns.cost]!;
    for (const [provider, match] of Object.entries(found)) {
      const settings = config.providers[provider]!;
      const { spare, blocked } = spareFor(quota.providers[provider], row.model);
      const bounded =
        settings.boundedOnly.some((id) => normalizeId(id) === key) ||
        (settings.boundedAboveCost !== undefined && cost > settings.boundedAboveCost);
      all.push({
        provider,
        modelId: match.id,
        model: row.model,
        vendor: row.vendor,
        effort: row.effort,
        score,
        cost,
        values: row.values,
        modelTags,
        bounded,
        heavy: score >= config.policy.heavyScore,
        maxHeavy: settings.maxHeavy,
        ...(running === undefined ? {} : { running: running[provider] ?? 0 }),
        ...(spare === undefined ? {} : { spare }),
        blocked,
        matchedTags: request.tags.filter((tag) => modelTags.includes(tag)),
        missingTags: request.tags.filter((tag) => !modelTags.includes(tag)),
        notes: [],
        offered: offersEffort(match.model, row.effort),
        vision: match.model.vision,
        key,
      });
    }
  }

  let remaining = all;
  const drop = (keep: (candidate: (typeof all)[number]) => boolean, counter: keyof Removed): void => {
    const kept = remaining.filter(keep);
    removed[counter] += remaining.length - kept.length;
    remaining = kept;
  };
  const isExcluded = (entry: Exclusion, candidate: (typeof all)[number]): boolean =>
    normalizeId(entry.model) === candidate.key && (entry.effort === undefined || entry.effort === candidate.effort);
  const hit = config.exclude.filter((entry) => remaining.some((candidate) => isExcluded(entry, candidate)));
  drop((c) => !config.exclude.some((entry) => isExcluded(entry, c)), "excluded");
  drop((c) => c.offered, "notOffered");
  if (request.needs.includes("vision")) drop((c) => c.vision, "needs");
  drop((c) => !avoided.has(c.key), "sameModel");
  const passed = remaining;

  drop((c) => !atHeavyLimit(c), "heavyLimit");
  drop((c) => !c.blocked, "exhausted");
  const inRange: Route[] = [];
  const above: Route[] = [];
  for (const candidate of remaining) {
    const away = distance(candidate.score, request);
    if (away < 0) removed.belowRange++;
    else if (away > 0) above.push(candidate);
    else inRange.push(candidate);
  }

  const clean = (candidate: (typeof all)[number] | Route): Route => {
    const { offered: _offered, vision: _vision, key: _key, ...rest } = candidate as (typeof all)[number];
    return rest;
  };
  const cut = <T>(routes: T[]): T[] => (request.limit > 0 ? routes.slice(0, request.limit) : routes);
  const rank = (routes: Route[], aboveRange: boolean): Route[] =>
    routes
      .map((candidate) => ({ ...clean(candidate), notes: notesFor(candidate, aboveRange) }))
      .map((candidate) => ({ candidate, key: rankKey(candidate, routing, avoidedVendors) }))
      .sort((a, b) => compareKeys(a.key, b.key))
      .map(({ candidate }) => candidate);

  const result = { removed, excluded: hit, warnings };
  if (inRange.length > 0) {
    removed.aboveRange = above.length;
    return {
      routes: cut(rank(inRange, false)),
      aboveRange: [],
      found: { routes: inRange.length, aboveRange: 0 },
      nearest: [],
      ...result,
    };
  }
  if (above.length > 0) {
    return { routes: [], aboveRange: cut(rank(above, true)), found: { routes: 0, aboveRange: above.length }, nearest: [], ...result };
  }

  const nearest = passed
    .map((candidate) => ({ candidate, away: Math.abs(distance(candidate.score, request)) }))
    .map(({ candidate, away }) => ({ candidate, away, key: rankKey(candidate, routing, avoidedVendors) }))
    .sort((a, b) => a.away - b.away || compareKeys(a.key, b.key))
    .slice(0, MAX_NEAREST)
    .map(({ candidate }) => ({
      ...clean(candidate),
      // The reason already says when the heavy limit is what keeps it out.
      notes: notesFor(candidate, false).filter((note) => !(atHeavyLimit(candidate) && note.startsWith("heavy, "))),
      why: whyOut(candidate, request),
    }));
  return { routes: [], aboveRange: [], found: { routes: 0, aboveRange: 0 }, nearest, ...result };
}
