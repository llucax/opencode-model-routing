// `model-route check`: finds what has gone stale, in the configuration and
// its data (models no provider offers, aliases gone) and in the agent
// configuration (model mentions and recommendations that no longer fit).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchModels, type Catalog } from "./catalog.ts";
import type { Routing } from "./config.ts";
import { dataModels, normalizeId } from "./data.ts";
import { unknownQuota } from "./quota.ts";
import { parseRange, UsageError, type Request } from "./request.ts";
import { route } from "./route.ts";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Problems with the configuration against the provider catalog: providers
 * it doesn't have, aliases it doesn't have, ambiguous matches, and data
 * models none of the configured providers offer.
 */
export function checkRoutes(routing: Routing, catalog: Catalog, configLabel: string): string[] {
  const { config, data } = routing;
  const problems: string[] = [];
  for (const provider of Object.keys(config.providers)) {
    if (!catalog.providers[provider]) problems.push(`${configLabel}: providers.${provider}: not a provider in ${catalog.source}`);
  }
  const models = dataModels(data);
  const matches = matchModels(
    [...models.values()].map((entry) => entry.model),
    config,
    catalog,
  );
  problems.push(...matches.missingAliases.map((message) => `${configLabel}: ${message}`));
  problems.push(...matches.ambiguous.map((message) => `${configLabel}: ${message}`));
  for (const [key, entry] of models) {
    if (Object.keys(matches.byModel.get(key) ?? {}).length > 0) continue;
    const line = data.rows.find((row) => normalizeId(row.model) === key)!.line;
    problems.push(
      `${config.data}:${line}: model "${entry.model}" is offered by none of the configured providers; if one has it under another ID, set it in the model's [[model]] ids`,
    );
  }
  return problems;
}

/**
 * Problems in one agent configuration file's text: model mentions at a
 * configured provider that aren't a data model's ID there, `--score` ranges
 * no route meets, unknown tags, and unknown jobs in `--job X`, `job: `X`` or
 * `` `job: X` ``.
 */
export function checkText(file: string, text: string, routing: Routing, catalog: Catalog): string[] {
  const { config, data } = routing;
  const problems: string[] = [];
  const models = dataModels(data);
  const matches = matchModels(
    [...models.values()].map((entry) => entry.model),
    config,
    catalog,
  );
  const known = new Set<string>();
  for (const found of matches.byModel.values()) {
    for (const [provider, match] of Object.entries(found)) known.add(`${provider}/${match.id}`);
  }
  // With no provider at all nothing can be a mention: `(?!)` never matches.
  const providers = Object.keys(config.providers).map(escapeRegExp).join("|") || "(?!)";
  const mention = new RegExp(`(?<![\\w./-])(${providers})/([A-Za-z0-9][A-Za-z0-9._-]*)`, "g");
  const meetable = new Map<string, boolean>();
  const quota = unknownQuota(config, "ignored");

  text.split("\n").forEach((line, index) => {
    const where = `${file}:${index + 1}`;

    for (const match of line.matchAll(mention)) {
      const id = match[2]!.replace(/[.-]+$/, "");
      if (!known.has(`${match[1]}/${id}`)) problems.push(`${where}: unknown model ${match[1]}/${id}, which is not a data model's ID there`);
    }

    // `--job X`, `job: \`X\`` or `\`job: X\``.
    for (const job of line.matchAll(/(?:--job[\s=]+|\bjob:\s*`|`job:\s*)([a-z][a-z0-9_-]*)/g)) {
      if (!(job[1]! in config.jobs)) problems.push(`${where}: unknown job "${job[1]}"`);
    }

    // A range recommendation: `--score <RANGE>`, maybe followed by `--tags <list>`.
    const score = /--score\s+([0-9][^\s`'")\],;]*)/.exec(line);
    if (!score) return;
    const rangeText = score[1]!;
    let range: { min: number; max?: number };
    try {
      range = parseRange(rangeText);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      problems.push(`${where}: ${error.message}`);
      return;
    }
    const after = line.slice(score.index + score[0].length);
    const tags = /--tags\s+([A-Za-z0-9_,-]+)/.exec(after);
    for (const tag of tags?.[1]!.split(",").filter((t) => t !== "") ?? []) {
      if (!(tag in config.tags)) problems.push(`${where}: unknown tag "${tag}" in the recommendation for --score ${rangeText}`);
    }
    if (!meetable.has(rangeText)) {
      const request: Request = { ...range, tags: [], needs: [], notModels: [], limit: 1 };
      meetable.set(rangeText, route(request, { routing, catalog, quota }).routes.length > 0);
    }
    if (!meetable.get(rangeText)) {
      problems.push(`${where}: no route has a score in ${rangeText}, with the provider catalog and the configured providers applied`);
    }
  });
  return problems;
}

/** The agent configuration files to check that exist under `dir`. */
export function configFiles(dir: string): string[] {
  const files: string[] = [];
  const add = (path: string): void => {
    if (existsSync(path)) files.push(path);
  };
  const entries = (sub: string): string[] => {
    try {
      return readdirSync(join(dir, sub)).sort();
    } catch {
      return [];
    }
  };
  add(join(dir, "AGENTS.md"));
  for (const name of entries("agents")) if (name.endsWith(".md")) add(join(dir, "agents", name));
  // existsSync follows symlinks, so symlinked skill directories count.
  for (const name of entries("skills")) add(join(dir, "skills", name, "SKILL.md"));
  for (const name of entries("tool-instructions")) if (name.endsWith(".md")) add(join(dir, "tool-instructions", name));
  return files;
}

/** Problems in every agent configuration file under `dir`, and how many files were read. */
export function checkConfigDir(dir: string, routing: Routing, catalog: Catalog): { problems: string[]; files: number } {
  const files = configFiles(dir);
  const problems: string[] = [];
  for (const file of files) problems.push(...checkText(file, readFileSync(file, "utf8"), routing, catalog));
  return { problems, files: files.length };
}
