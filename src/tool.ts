// The model_route tool: the same core as the command line, with live state
// from OpenCode (its providers' models, the heavy sessions running).

import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin";
import { CatalogError, defaultModelsJsonPath, loadModelsJson, matchModels, type Catalog } from "./catalog.ts";
import { loadConfig, loadRouting, locateConfig, type Config, type Routing } from "./config.ts";
import { dataModels, isEffort, normalizeId } from "./data.ts";
import { formatBrief, NO_WORKAROUND } from "./format.ts";
import { liveCatalog, runningSessions, type RunningSession } from "./live.ts";
import { loadQuota, type Quota } from "./quota.ts";
import { buildRequest, NEEDS, UsageError } from "./request.ts";
import { route, type Route } from "./route.ts";
import { ValidationError } from "./validate.ts";

export interface ToolArgs {
  job?: string;
  score?: string;
  tags?: string[];
  need?: string[];
  not_model?: string[];
  limit?: number;
}

/**
 * How many heavy sessions run per provider. A session counts when its model
 * is a data model at a configured provider and its row at the session's
 * effort is heavy; with no variant, or an effort the data lacks, it counts
 * when any row of the model is heavy.
 */
export function countHeavy(
  sessions: RunningSession[],
  routing: Routing,
  catalog: Catalog,
): { running: Record<string, number>; notes: string[] } {
  const { config, data } = routing;
  const models = dataModels(data);
  const matches = matchModels(
    [...models.values()].map((entry) => entry.model),
    config,
    catalog,
  );
  // Provider and its model ID to the data model's normalized ID.
  const reverse = new Map<string, string>();
  for (const [key, found] of matches.byModel) {
    for (const [provider, match] of Object.entries(found)) reverse.set(`${provider}/${match.id}`, key);
  }
  const running: Record<string, number> = {};
  for (const provider of Object.keys(config.providers)) running[provider] = 0;
  let withoutModel = 0;
  let guessed = 0;
  for (const session of sessions) {
    if (!session.model) {
      withoutModel++;
      continue;
    }
    const { providerID, modelID, variant } = session.model;
    if (!(providerID in running)) continue;
    const key = reverse.get(`${providerID}/${modelID}`);
    if (key === undefined) continue;
    const rows = data.rows.filter((row) => normalizeId(row.model) === key);
    const exact = variant !== undefined && isEffort(variant) ? rows.find((row) => row.effort === variant) : undefined;
    const scores = exact ? [exact.values[config.columns.score]!] : rows.map((row) => row.values[config.columns.score]!);
    if (!exact) guessed++;
    if (scores.some((score) => score >= config.policy.heavyScore)) running[providerID]!++;
  }
  const notes: string[] = [];
  if (withoutModel > 0) notes.push(`${withoutModel} running session${withoutModel === 1 ? " has" : "s have"} no model yet and ${withoutModel === 1 ? "was" : "were"} not counted.`);
  if (guessed > 0) notes.push(`${guessed} running session${guessed === 1 ? "'s" : "s'"} effort is not in the data; counted as heavy if the model has a heavy effort.`);
  return { running, notes };
}

/** The tool's description, with the configured jobs; one line. */
export function toolDescription(config: Config | undefined): string {
  const base =
    "Pick the model and variant for a subagent or session: pass `job`, or the `score` and `tags` an agent description recommends.";
  if (!config || Object.keys(config.jobs).length === 0) return base;
  const jobs = Object.values(config.jobs).map((job) => `${job.name} ${job.score}${job.tags.length > 0 ? ` ${job.tags.join(",")}` : ""} (${job.about})`);
  return `${base} Jobs: ${jobs.join("; ")}.`;
}

/** The tool's parameters; `job` is an enum of the configured jobs. */
export function toolParameters(config: Config | undefined) {
  const z = tool.schema;
  const jobs = Object.keys(config?.jobs ?? {});
  return {
    job: (jobs.length > 0 ? z.enum(jobs as [string, ...string[]]) : z.string()).optional().describe("A job; `job` or `score` is required"),
    score: z.string().optional().describe("`A-B` or `A+`, replacing the job's"),
    tags: z.array(z.string()).optional().describe("Preferred tags, replacing the job's"),
    need: z.array(z.enum(NEEDS as [string, ...string[]])).optional().describe("Required capabilities"),
    not_model: z.array(z.string()).optional().describe("Models to avoid, for second opinions: the author's `provider/model`"),
    limit: z.number().int().min(0).optional().describe("Routes to return, 0 for all (default 1)"),
  };
}

export interface ToolDeps {
  routing(): Routing;
  catalog(): Promise<{ catalog: Catalog; warnings: string[] }>;
  quota(config: Config): Promise<Quota>;
  sessions(): Promise<{ sessions: RunningSession[]; warnings: string[] }>;
}

/** A failure the agent must not work around. */
export class ToolError extends Error {}

function fail(messages: string[]): never {
  throw new ToolError(`${messages.join("\n")}\n${NO_WORKAROUND}`);
}

/** Runs one request; returns the first route's name and the output. */
export async function runTool(args: ToolArgs, deps: ToolDeps): Promise<{ title: string; output: string; routes: Route[] }> {
  try {
    if (args.job === undefined && args.score === undefined) throw new UsageError("pass `job` or `score`");
    const routing = deps.routing();
    const request = buildRequest(
      {
        ...(args.job !== undefined ? { job: args.job } : {}),
        ...(args.score !== undefined ? { score: args.score } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        needs: args.need ?? [],
        notModels: args.not_model ?? [],
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
      routing.config,
      1,
    );
    const [{ catalog, warnings: catalogWarnings }, quota, live] = await Promise.all([
      deps.catalog(),
      deps.quota(routing.config),
      deps.sessions(),
    ]);
    const heavy = countHeavy(live.sessions, routing, catalog);
    const result = route(request, { routing, catalog, quota, running: heavy.running });
    const warnings = [...catalogWarnings, ...quota.warnings, ...live.warnings, ...result.warnings].map((warning) => `warning: ${warning}`);
    const output = formatBrief(result, request, quota, routing, [...heavy.notes, ...warnings]);
    const first = result.routes[0] ?? result.aboveRange[0];
    return { title: first ? `${first.provider}/${first.modelId} ${first.effort}` : "no route", output, routes: [...result.routes, ...result.aboveRange] };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error instanceof ValidationError) fail(error.messages);
    if (error instanceof UsageError || error instanceof CatalogError) fail([error.message]);
    throw error;
  }
}

/** The configuration at load time, for the description; undefined when it can't be read. */
function configAtLoad(): Config | undefined {
  try {
    return loadConfig(locateConfig(undefined));
  } catch {
    return undefined;
  }
}

/** The live catalog, or models.json with a warning when OpenCode can't give it. */
async function catalogFor(client: PluginInput["client"]): Promise<{ catalog: Catalog; warnings: string[] }> {
  try {
    return { catalog: await liveCatalog(client), warnings: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { catalog: loadModelsJson(defaultModelsJsonPath()), warnings: [`connected providers unavailable (${reason}); used models.json`] };
  }
}

/** The model_route tool for a plugin. Routing reads the configuration on every call; the jobs listed need a restart. */
export function createTool(input: PluginInput): ToolDefinition {
  const config = configAtLoad();
  return tool({
    description: toolDescription(config),
    args: toolParameters(config),
    async execute(args) {
      const { title, output } = await runTool(args as ToolArgs, {
        routing: () => loadRouting(locateConfig(undefined)),
        catalog: () => catalogFor(input.client),
        quota: (current) => loadQuota(current, new Date()),
        sessions: () => runningSessions(input.client),
      });
      return { title, output };
    },
  });
}
