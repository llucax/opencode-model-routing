// Output: the text view for a terminal, the JSON object for programs, and the
// short text the tool returns to agents.

import { describeSource, type Config, type ConfigFile, type Provider, type Routing } from "./config.ts";
import type { ProviderQuota, Quota } from "./quota.ts";
import type { Request } from "./request.ts";
import type { Nearest, Removed, Route, RouteResult } from "./route.ts";

/** What removed each kind of route, in the order the filters run. */
const REMOVED_LABELS: [keyof Removed, string][] = [
  ["noProvider", "no provider"],
  ["excluded", "excluded"],
  ["notOffered", "not offered"],
  ["needs", "needs"],
  ["sameModel", "same model"],
  ["heavyLimit", "heavy limit"],
  ["exhausted", "exhausted"],
  ["belowRange", "below range"],
  ["aboveRange", "above range"],
];

/** The instruction every failed routing ends with. */
export const NO_WORKAROUND = "Fix the cause or ask the user; never pick a model another way.";

/** `+3`, `-12` or `?`. */
export function formatSpare(spare: number | undefined): string {
  if (spare === undefined) return "?";
  const rounded = Math.round(spare);
  return rounded < 0 ? `-${-rounded}` : `+${rounded}`;
}

/** `1h55m`, `6d`, `40m`: days once there is at least one, else hours and minutes. */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${minutes}m`;
}

function formatPercent(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}

/** A number with at most two decimals and no trailing zeros. */
export function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** `excluded: gpt-x high (too slow), ...`, or undefined when nothing was excluded. */
function describeExcluded(result: RouteResult): string | undefined {
  if (result.excluded.length === 0) return undefined;
  return `excluded: ${result.excluded.map((e) => `${e.model}${e.effort ? ` ${e.effort}` : ""} (${e.reason})`).join(", ")}`;
}

/** The request in words, as in `job implement, score 600-720, tags impl`. */
export function describeRequest(request: Request): string {
  const parts: string[] = [];
  if (request.job !== undefined) parts.push(`job ${request.job}`);
  if (request.min !== undefined && request.max !== undefined) parts.push(`score ${request.min}-${request.max}`);
  else if (request.min !== undefined) parts.push(`score ${request.min}+`);
  if (request.tags.length > 0) parts.push(`tags ${request.tags.join(",")}`);
  if (request.needs.length > 0) parts.push(`need ${request.needs.join(",")}`);
  if (request.notModels.length > 0) parts.push(`not model ${request.notModels.join(",")}`);
  return parts.length > 0 ? parts.join(", ") : "any request";
}

/** `4 not offered, 9 below range`, or empty when nothing was removed. */
function describeRemoved(removed: Removed): string {
  return REMOVED_LABELS.filter(([key]) => removed[key] > 0)
    .map(([key, label]) => `${removed[key]} ${label}`)
    .join(", ");
}

/** A provider's spare (the worst of its windows) and whether any window is blocked. */
export function providerSpare(quota: ProviderQuota): { spare?: number; blocked: boolean } {
  if (quota.windows.length === 0) return { blocked: false };
  return {
    spare: Math.min(...quota.windows.map((window) => window.spare)),
    blocked: quota.windows.some((window) => window.blocked),
  };
}

function pad(text: string, width: number, right = false): string {
  return right ? text.padStart(width) : text.padEnd(width);
}

function renderTable(headers: string[], rows: string[][], rightAligned: number[]): string[] {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column]!.length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => pad(cell, widths[column]!, rightAligned.includes(column)))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** One line per configured provider with its spare and windows. */
export function formatQuota(quota: Quota, config: Config): string[] {
  const names = Object.keys(config.providers);
  const labels = names.map((name) => {
    const plan = config.providers[name]!.plan;
    return plan === undefined ? name : `${name} (${plan})`;
  });
  const nameWidth = Math.max(...labels.map((label) => label.length));
  const spares = names.map((name) => {
    const state = quota.providers[name];
    const { spare, blocked } = state ? providerSpare(state) : { spare: undefined, blocked: false };
    return `spare ${formatSpare(spare)}${blocked ? " BLOCKED" : ""}`;
  });
  const spareWidth = Math.max(...spares.map((text) => text.length));
  return names.map((name, index) => {
    const state = quota.providers[name];
    const windows = (state?.windows ?? []).map((window) => {
      const scope = window.models ? ` (${window.models.join(", ")} only)` : "";
      const blocked = window.blocked ? " BLOCKED" : "";
      return `${window.label} ${formatPercent(window.percentRemaining)} (${formatDuration(window.secondsToReset)}) ${formatSpare(window.spare)}${blocked}${scope}`;
    });
    const detail = windows.length > 0 ? windows.join(", ") : (state?.reason ?? "no quota data");
    return `${pad(labels[index]!, nameWidth)}  ${pad(spares[index]!, spareWidth)}  ${detail}`;
  });
}

/** The notes as shown in the table: the row already has the provider, so heavy is short. */
function tableNotes(route: Route): string[] {
  return route.notes.map((note) => {
    if (!note.startsWith("heavy, ")) return note;
    return route.running === undefined ? `heavy (max ${route.maxHeavy})` : `heavy (${route.running} of ${route.maxHeavy})`;
  });
}

/** The routes as a table: provider/model, effort, the used columns, spare, tags, notes. */
export function formatRoutes(routes: (Route | Nearest)[], columns: string[]): string[] {
  const rows = routes.map((route) => {
    const notes = tableNotes(route);
    const why = "why" in route ? route.why : undefined;
    return [
      `${route.provider}/${route.modelId}`,
      route.effort,
      ...columns.map((column) => formatNumber(route.values[column]!)),
      formatSpare(route.spare),
      route.modelTags.join(", "),
      (why ? [why, ...notes] : notes).join("; "),
    ];
  });
  const numeric = columns.map((_, i) => i + 2);
  return renderTable(["provider/model", "effort", ...columns, "spare", "tags", "notes"], rows, [...numeric, numeric.length + 2]);
}

function countText(shown: number, found: number, noun: string): string {
  const text = `${found} ${noun}${found === 1 ? "" : "s"}`;
  return shown < found ? `${text}, showing ${shown}` : text;
}

/** The whole text output, without warnings. */
export function formatText(result: RouteResult, request: Request, quota: Quota, routing: Routing): string {
  const { config } = routing;
  const columns = config.columns.use;
  const lines = [...formatQuota(quota, config), ""];
  const description = describeRequest(request);
  const removed = describeRemoved(result.removed);
  const removedText = removed ? `; removed ${removed}` : "";
  const excludedText = describeExcluded(result);
  if (result.routes.length > 0) {
    lines.push(...formatRoutes(result.routes, columns), "");
    lines.push(`${description}: ${countText(result.routes.length, result.found.routes, "route")}${removedText}`);
    if (excludedText) lines.push(excludedText);
  } else if (result.aboveRange.length > 0) {
    lines.push(...formatRoutes(result.aboveRange, columns), "");
    const above = countText(result.aboveRange.length, result.found.aboveRange, "route");
    lines.push(`${description}: none in range, ${above} above range${removedText}`);
    if (excludedText) lines.push(excludedText);
  } else {
    lines.push(`No route matches ${description}`);
    if (removed) lines.push(`removed ${removed}`);
    if (excludedText) lines.push(excludedText);
    if (result.nearest.length > 0) lines.push("", "Nearest:", ...formatRoutes(result.nearest, columns));
  }
  return lines.join("\n") + "\n";
}

/** `anthropic spare +12, openai spare -30 BLOCKED`, for every configured provider. */
function quotaSummary(quota: Quota, config: Config): string {
  return Object.keys(config.providers)
    .map((name) => {
      const state = quota.providers[name];
      const { spare, blocked } = state ? providerSpare(state) : { spare: undefined, blocked: false };
      return `${name} spare ${formatSpare(spare)}${blocked ? " BLOCKED" : ""}`;
    })
    .join(", ");
}

/** `anthropic/x high (intelligence 820, cost_per_task 22): heavy, 1 of 2 running on anthropic`. */
function briefRoute(route: Route | Nearest, columns: string[]): string {
  const values = columns.map((column) => `${column} ${formatNumber(route.values[column]!)}`).join(", ");
  const notes = "why" in route ? [route.why, ...route.notes] : route.notes;
  return `${route.provider}/${route.modelId} ${route.effort} (${values})${notes.length > 0 ? `: ${notes.join("; ")}` : ""}`;
}

/**
 * The tool's output: the routes first, one line each, then the quota, then
 * what the agent must keep in mind. On no route, why and what to do.
 */
export function formatBrief(result: RouteResult, request: Request, quota: Quota, routing: Routing, notes: string[]): string {
  const { config } = routing;
  const columns = config.columns.use;
  const routes = result.routes.length > 0 ? result.routes : result.aboveRange;
  const lines: string[] = [];
  if (routes.length > 0) {
    lines.push(...routes.map((route) => briefRoute(route, columns)));
    lines.push(`quota: ${quotaSummary(quota, config)}`);
    const found = result.routes.length > 0 ? result.found.routes : result.found.aboveRange;
    if (routes.length < found) lines.push(`${found - routes.length} more routes; pass limit to see them.`);
    if (routes.some((route) => route.heavy)) lines.push("Long-running workers count as heavy too.");
    if (routes.some((route) => route.bounded)) lines.push("Bounded work only: one bounded job, never a loop or long session.");
  } else {
    const removed = describeRemoved(result.removed);
    lines.push(`No route matches ${describeRequest(request)}${removed ? `; removed ${removed}` : ""}.`);
    lines.push(`quota: ${quotaSummary(quota, config)}`);
    const excluded = describeExcluded(result);
    if (excluded) lines.push(excluded);
    if (result.nearest.length > 0) lines.push("Nearest, not usable:", ...result.nearest.map((route) => `  ${briefRoute(route, columns)}`));
    lines.push(NO_WORKAROUND);
  }
  lines.push(...notes);
  return lines.join("\n");
}

function jsonRoute(route: Route | Nearest): Record<string, unknown> {
  return { ...route, spare: route.spare ?? null, running: route.running ?? null };
}

/** The JSON object printed by `--json`. */
export function jsonReport(
  result: RouteResult,
  request: Request,
  quota: Quota,
  routing: Routing,
  warnings: string[],
): Record<string, unknown> {
  const { config, data } = routing;
  return {
    version: 2,
    snapshot: data.snapshot ?? null,
    columns: config.columns,
    request: {
      job: request.job ?? null,
      min: request.min ?? null,
      max: request.max ?? null,
      tags: request.tags,
      needs: request.needs,
      notModels: request.notModels,
      limit: request.limit,
    },
    warnings,
    quota: Object.keys(config.providers).map((name) => {
      const state = quota.providers[name] ?? { provider: name, windows: [] };
      const { spare, blocked } = providerSpare(state);
      const plan = config.providers[name]?.plan;
      return {
        provider: name,
        ...(plan === undefined ? {} : { plan }),
        spare: spare ?? null,
        blocked,
        maxHeavy: config.providers[name]?.maxHeavy ?? null,
        ...(state.reason ? { reason: state.reason } : {}),
        windows: state.windows,
      };
    }),
    routes: result.routes.map(jsonRoute),
    aboveRange: result.aboveRange.map(jsonRoute),
    found: result.found,
    removed: result.removed,
    excluded: result.excluded,
    nearest: result.nearest.map(jsonRoute),
  };
}

/** Where the configuration was read from. */
export interface ConfigSources {
  /** The configuration file: its absolute path and how it was found. */
  config: ConfigFile;
}

/** `key  value` lines, indented, with the values aligned; a value with several lines continues under the first. */
function keyValueLines(pairs: [string, string[]][]): string[] {
  if (pairs.length === 0) return [];
  const width = Math.max(...pairs.map(([key]) => key.length));
  return pairs.flatMap(([key, values]) => values.map((value, index) => `  ${pad(index === 0 ? key : "", width)}  ${value}`));
}

function describeWindow(window: Provider["windowOverrides"][number]): string {
  return `${window.name} (${[window.length, ...(window.models ? [`${window.models.join(", ")} only`] : [])].join(", ")})`;
}

function providerLines(provider: Provider): string[] {
  const pairs: [string, string[]][] = [["max_heavy", [String(provider.maxHeavy)]]];
  if (provider.quotaName !== undefined) pairs.push(["quota_name", [provider.quotaName]]);
  if (provider.boundedOnly.length > 0) pairs.push(["bounded_only", [provider.boundedOnly.join(", ")]]);
  if (provider.boundedAboveCost !== undefined) pairs.push(["bounded_above_cost", [String(provider.boundedAboveCost)]]);
  if (provider.windowOverrides.length > 0) pairs.push(["window_overrides", provider.windowOverrides.map(describeWindow)]);
  return [provider.plan === undefined ? provider.name : `${provider.name} (${provider.plan})`, ...keyValueLines(pairs)];
}

/** The text of `model-route config`: the files used, then the effective configuration. */
export function formatConfig(sources: ConfigSources, routing: Routing): string {
  const { config, data } = routing;
  const { policy, columns } = config;
  const lines = [
    `config  ${sources.config.path} (${describeSource(sources.config.source)})`,
    `data    ${config.data} (${data.rows.length} rows${data.snapshot ? `, snapshot ${data.snapshot}` : ""})`,
    "",
    "columns",
    ...keyValueLines([
      ["use", [columns.use.join(", ")]],
      ["score", [columns.score]],
      ["cost", [columns.cost]],
    ]),
    "",
    "policy",
    ...keyValueLines([
      ["prefer", [policy.prefer.join(", ")]],
      ["prefer_min_spare", [String(policy.preferMinSpare)]],
      ["spare_step", [String(policy.spareStep)]],
      ["cheap_cost", [String(policy.cheapCost)]],
      ["heavy_score", [String(policy.heavyScore)]],
    ]),
  ];
  for (const provider of Object.values(config.providers)) lines.push("", ...providerLines(provider));
  const jobs = Object.values(config.jobs);
  if (jobs.length > 0) {
    lines.push("", "jobs", ...keyValueLines(jobs.map((job) => [job.name, [`${job.score}${job.tags.length > 0 ? ` ${job.tags.join(",")}` : ""}: ${job.about}`]])));
  }
  if (Object.keys(config.tags).length > 0) lines.push("", "tags", ...keyValueLines(Object.entries(config.tags).map(([tag, about]) => [tag, [about]])));
  const models = Object.values(config.models);
  if (models.length > 0) {
    lines.push(
      "",
      "models",
      ...keyValueLines(
        models.map((model) => [
          model.id,
          [[model.tags.join(", "), ...Object.entries(model.ids).map(([provider, id]) => `${provider}/${id}`)].filter((part) => part !== "").join("; ")],
        ]),
      ),
    );
  }
  if (config.exclude.length > 0) {
    lines.push("", "exclude", ...config.exclude.map((entry) => `  ${entry.model}${entry.effort ? ` ${entry.effort}` : ""}: ${entry.reason}`));
  }
  return lines.join("\n") + "\n";
}

/** The JSON object printed by `model-route config --json`. */
export function jsonConfig(sources: ConfigSources, routing: Routing): Record<string, unknown> {
  const { config, data } = routing;
  return {
    version: 2,
    config: { path: sources.config.path, source: sources.config.source },
    data: { path: config.data, rows: data.rows.length, snapshot: data.snapshot ?? null },
    columns: config.columns,
    policy: config.policy,
    providers: Object.values(config.providers).map((provider) => ({
      name: provider.name,
      plan: provider.plan ?? null,
      quotaName: provider.quotaName ?? null,
      maxHeavy: provider.maxHeavy,
      boundedOnly: provider.boundedOnly,
      boundedAboveCost: provider.boundedAboveCost ?? null,
      windowOverrides: provider.windowOverrides.map((window) => ({ ...window, models: window.models ?? null })),
    })),
    jobs: Object.values(config.jobs).map((job) => ({ name: job.name, score: job.score, tags: job.tags, about: job.about })),
    tags: config.tags,
    models: Object.values(config.models),
    exclude: config.exclude.map((entry) => ({ ...entry, effort: entry.effort ?? null })),
  };
}
