// Requests: what both frontends accept, checked against the configuration.

import type { Config } from "./config.ts";
import type { Expr } from "./expr.ts";

/** A problem with the request or the environment: printed as one line, exit status 1. */
export class UsageError extends Error {}

/** Capabilities a request may need. */
export const NEEDS = ["vision"];

/** Parses `A-B` or `A+`, with integer or decimal bounds and A <= B. */
export function parseRange(text: string): { min: number; max?: number } {
  const number = "(\\d+(?:\\.\\d+)?)";
  const atLeast = new RegExp(`^${number}\\+$`).exec(text);
  if (atLeast) return { min: Number(atLeast[1]) };
  const between = new RegExp(`^${number}-${number}$`).exec(text);
  if (between) {
    const min = Number(between[1]);
    const max = Number(between[2]);
    if (min > max) throw new UsageError(`invalid score range "${text}": the lower bound is above the upper bound`);
    return { min, max };
  }
  throw new UsageError(`invalid score range "${text}": use A-B or A+, for example 600-720 or 780+`);
}

/** Splits each value on commas and drops empty parts. */
export function splitList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(",")).map((part) => part.trim()).filter((part) => part !== "");
}

export interface Request {
  /** The job the range and tags came from, if any. */
  job?: string;
  /** Lowest acceptable score. */
  min?: number;
  /** Highest score to prefer; routes above it are only offered when nothing is in range. */
  max?: number;
  tags: string[];
  /** Capabilities the model must have; only "vision" for now. */
  needs: string[];
  /** Models to avoid: data IDs, or IDs at a provider with its `provider/` prefix. */
  notModels: string[];
  /** How many routes to return, 0 for all. */
  limit: number;
  /** The formula routes rank by: the job's, else `formulas.value`. */
  value: Expr;
  /** The filter routes must pass, if any: the job's. */
  where?: Expr;
}

/** A request as a frontend gets it; `undefined` means not given. */
export interface RequestInput {
  job?: string;
  score?: string;
  /** Given, even empty, it replaces the job's tags. */
  tags?: string[];
  needs?: string[];
  notModels?: string[];
  limit?: number;
  /** Replaces the job's value formula, or `formulas.value`. */
  value?: Expr;
  /** Replaces the job's filter. */
  where?: Expr;
}

function unknownTagMessage(tag: string, config: Config): string {
  const names = Object.keys(config.tags);
  if (names.length === 0) return `unknown tag "${tag}"; the configuration defines no tags`;
  const width = Math.max(...names.map((name) => name.length));
  const known = Object.entries(config.tags).map(([name, meaning]) => `  ${name.padEnd(width)}  ${meaning}`);
  return [`unknown tag "${tag}"; the known tags are:`, ...known].join("\n");
}

/** The jobs, one per line, as `  name  range, tags: about`. */
export function describeJobs(config: Config): string[] {
  const jobs = Object.values(config.jobs);
  const width = Math.max(...jobs.map((job) => job.name.length));
  return jobs.map((job) => `  ${job.name.padEnd(width)}  ${job.score}${job.tags.length > 0 ? ` ${job.tags.join(",")}` : ""}: ${job.about}`);
}

/**
 * The request the input describes. A job gives the range, tags, value
 * formula and filter; a score, tags, value or filter given with it replace
 * the job's. `defaultLimit` applies when no limit is given.
 */
export function buildRequest(input: RequestInput, config: Config, defaultLimit: number): Request {
  let range: { min?: number; max?: number } = {};
  let tags: string[] = [];
  let value = config.formulas.value!;
  let where: Expr | undefined;
  if (input.job !== undefined) {
    const job = config.jobs[input.job];
    if (!job) {
      if (Object.keys(config.jobs).length === 0) throw new UsageError(`unknown job "${input.job}"; the configuration defines no jobs`);
      throw new UsageError([`unknown job "${input.job}"; the jobs are:`, ...describeJobs(config)].join("\n"));
    }
    range = job.max === undefined ? { min: job.min } : { min: job.min, max: job.max };
    tags = job.tags;
    if (job.value) value = job.value;
    where = job.where;
  }
  if (input.value !== undefined) value = input.value;
  if (input.where !== undefined) where = input.where;
  if (input.score !== undefined) range = parseRange(input.score);
  if (input.tags !== undefined) tags = input.tags;
  for (const tag of tags) {
    if (!(tag in config.tags)) throw new UsageError(unknownTagMessage(tag, config));
  }
  const needs = input.needs ?? [];
  for (const need of needs) {
    if (!NEEDS.includes(need)) throw new UsageError(`unknown need "${need}"; the known needs are: ${NEEDS.join(", ")}`);
  }
  const limit = input.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 0) throw new UsageError(`invalid limit ${limit}: use a positive integer, or 0 for every route`);
  return {
    ...(input.job !== undefined ? { job: input.job } : {}),
    ...range,
    tags: [...new Set(tags)],
    needs: [...new Set(needs)],
    notModels: input.notModels ?? [],
    limit,
    value,
    ...(where ? { where } : {}),
  };
}
