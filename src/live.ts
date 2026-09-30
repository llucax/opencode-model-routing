// Live state from the running OpenCode server, for the tool: the models its
// connected providers expose, and the sessions running right now.

import type { PluginInput } from "@opencode-ai/plugin";
import type { Catalog, CatalogModel } from "./catalog.ts";

type Client = PluginInput["client"];
type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The catalog of the connected providers. The v1 SDK's `Model` type lacks
 * `variants`, which the server sends: its keys are the efforts.
 */
export async function liveCatalog(client: Client): Promise<Catalog> {
  const response = await client.config.providers({ throwOnError: true });
  const providers: Catalog["providers"] = {};
  for (const provider of response.data.providers) {
    const models: Record<string, CatalogModel> = {};
    for (const [id, model] of Object.entries(provider.models)) {
      const variants = (model as { variants?: unknown }).variants;
      models[id] = {
        efforts: isObj(variants) ? Object.keys(variants) : [],
        vision: model.capabilities?.input?.image === true,
      };
    }
    providers[provider.id] = models;
  }
  return { source: "OpenCode's connected providers", providers };
}

/** A session that is busy or retrying, with the model of its latest prompt when it has one. */
export interface RunningSession {
  id: string;
  directory: string;
  model?: { providerID: string; modelID: string; variant?: string };
}

/** How far back to look for sessions: a busy session was updated more recently than this. */
const RECENT_MS = 24 * 3600 * 1000;
const MAX_SESSIONS = 1000;

interface ListedSession {
  id: string;
  directory: string;
  model?: { id?: string; providerID?: string; variant?: string };
}

/**
 * Sessions updated recently, across every directory. `/experimental/session`
 * lists them globally, but the v1 SDK has no method for it, and its client
 * adds the caller's directory to every GET, which would filter the list; an
 * empty `directory` avoids both.
 */
async function recentSessions(client: Client, now: number): Promise<ListedSession[]> {
  const raw = (client as unknown as { _client: { get(options: unknown): Promise<{ data: unknown }> } })._client;
  const response = await raw.get({
    url: "/experimental/session",
    query: { directory: "", start: now - RECENT_MS, limit: MAX_SESSIONS },
    throwOnError: true,
  });
  if (!Array.isArray(response.data)) throw new Error("unexpected /experimental/session response");
  return response.data as ListedSession[];
}

/**
 * Every busy or retrying session on this server. Status is kept per
 * directory, so it is asked once for each directory with recent sessions.
 * The model is the session's own, which each prompt sets.
 */
export async function runningSessions(client: Client, now = Date.now()): Promise<{ sessions: RunningSession[]; warnings: string[] }> {
  const warnings: string[] = [];
  let listed: ListedSession[];
  try {
    listed = await recentSessions(client, now);
  } catch (error) {
    warnings.push(`sessions of other directories not seen (${error instanceof Error ? error.message : String(error)})`);
    const response = await client.session.list({ throwOnError: true });
    listed = response.data as ListedSession[];
  }
  const directories = [...new Set(listed.map((session) => session.directory))];
  const statuses = new Map<string, string>();
  await Promise.all(
    directories.map(async (directory) => {
      const response = await client.session.status({ query: { directory }, throwOnError: true });
      for (const [id, status] of Object.entries(response.data)) statuses.set(id, status.type);
    }),
  );
  const sessions: RunningSession[] = [];
  for (const session of listed) {
    const status = statuses.get(session.id);
    if (status !== "busy" && status !== "retry") continue;
    const model = session.model;
    sessions.push({
      id: session.id,
      directory: session.directory,
      ...(model?.id && model.providerID
        ? {
            model: {
              providerID: model.providerID,
              modelID: model.id,
              ...(model.variant && model.variant !== "default" ? { variant: model.variant } : {}),
            },
          }
        : {}),
    });
  }
  return { sessions, warnings };
}
