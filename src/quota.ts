// Provider quota: the spare of each quota window, from the output of
// `opencode-quota show --json`.
//
// Spare is the percent remaining minus the share of the window still to run,
// in points: a window that is 40% used and 60% elapsed has +20 spare.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { normalizeId, parseWindowLength, type WindowLength } from "./data.ts";

/** One quota window of a provider, as of `now`. */
export interface WindowState {
  name: string;
  /** What to show for the window: its length as the quota data writes it (lowercase), else its name. */
  label: string;
  percentRemaining: number;
  /** Seconds until the window resets, at least 0. */
  secondsToReset: number;
  spare: number;
  blocked: boolean;
  /** Model IDs the window is limited to; absent means every model. */
  models?: string[];
}

/** The quota of one configured provider. No windows means the spare is unknown. */
export interface ProviderQuota {
  provider: string;
  /** Why there are no windows. */
  reason?: string;
  windows: WindowState[];
}

export interface Quota {
  providers: Record<string, ProviderQuota>;
  warnings: string[];
}

/** The spare of a model at a provider: the minimum over the windows that apply to it. */
export interface Spare {
  /** Undefined when no window applies. */
  spare?: number;
  blocked: boolean;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The length of the calendar month (UTC) that contains `resetAt - 1 s`, up to `resetAt`, in seconds. */
export function monthlyLength(resetAt: number): number {
  const containing = new Date((resetAt - 1) * 1000);
  const start = Date.UTC(containing.getUTCFullYear(), containing.getUTCMonth(), 1) / 1000;
  return resetAt - start;
}

function lengthSeconds(length: WindowLength, resetAt: number): number {
  return length === "monthly" ? monthlyLength(resetAt) : length;
}

/** Computes the quota of every configured provider from parsed `show --json` output. */
export function computeQuota(json: unknown, config: Config, now: Date): Quota {
  const warnings: string[] = [];
  const providers: Record<string, ProviderQuota> = {};
  const nowSeconds = now.getTime() / 1000;
  const reported = isObj(json) && isObj(json.providers) ? json.providers : undefined;

  for (const provider of Object.values(config.providers)) {
    const quotaName = provider.quotaName ?? provider.name;
    const item = reported?.[quotaName];
    if (!isObj(item)) {
      providers[provider.name] = { provider: provider.name, reason: "not in the quota data", windows: [] };
      continue;
    }
    if (item.status === "error" || item.status === "unavailable") {
      providers[provider.name] = { provider: provider.name, reason: `quota ${item.status}`, windows: [] };
      continue;
    }

    const windows: WindowState[] = [];
    for (const entry of Array.isArray(item.entries) ? item.entries : []) {
      if (!isObj(entry) || entry.renderType !== "percent") continue;
      const { name, resetAt, percentRemaining } = entry;
      if (typeof name !== "string" || typeof resetAt !== "number" || typeof percentRemaining !== "number") {
        warnings.push(`quota entry in ${provider.name} is malformed; ignored`);
        continue;
      }
      const configured = provider.windowOverrides.find((window) => window.name === name);
      const fromEntry = typeof entry.window === "string" ? parseWindowLength(entry.window) : undefined;
      const length = fromEntry ?? (configured ? parseWindowLength(configured.length) : undefined);
      if (length === undefined) {
        warnings.push(`quota window "${provider.name}: ${name}" has no known length; ignored`);
        continue;
      }
      const seconds = lengthSeconds(length, resetAt);
      const share = Math.min(1, Math.max(0, (resetAt - nowSeconds) / seconds));
      windows.push({
        name,
        label: typeof entry.window === "string" && entry.window.trim() !== "" ? entry.window.trim().toLowerCase() : name,
        percentRemaining,
        secondsToReset: Math.max(0, resetAt - nowSeconds),
        spare: percentRemaining - 100 * share,
        blocked: percentRemaining === 0 && resetAt > nowSeconds,
        ...(configured?.models ? { models: configured.models } : {}),
      });
    }
    providers[provider.name] = {
      provider: provider.name,
      ...(windows.length === 0 ? { reason: "no usable quota windows" } : {}),
      windows,
    };
  }
  return { providers, warnings };
}

/** Quota with every spare unknown, for when the quota data couldn't be read. */
export function unknownQuota(config: Config, reason: string): Quota {
  const providers: Record<string, ProviderQuota> = {};
  for (const name of Object.keys(config.providers)) providers[name] = { provider: name, reason, windows: [] };
  return { providers, warnings: [] };
}

/** The spare of the model with data ID `model` given a provider's quota. */
export function spareFor(quota: ProviderQuota | undefined, model: string): Spare {
  const key = normalizeId(model);
  let spare: number | undefined;
  let blocked = false;
  for (const window of quota?.windows ?? []) {
    if (window.models && !window.models.some((id) => normalizeId(id) === key)) continue;
    spare = spare === undefined ? window.spare : Math.min(spare, window.spare);
    blocked ||= window.blocked;
  }
  return { ...(spare === undefined ? {} : { spare }), blocked };
}

// The adapter: gets the quota JSON from a file or from the quota CLI.

const QUOTA_TIMEOUT_MS = 20_000;
const QUOTA_PACKAGE = "@slkiser/opencode-quota";

/** Numeric, part by part, version comparison. */
function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map(Number);
  const right = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
  }
  return 0;
}

/**
 * The opencode-quota version pinned in OpenCode's configuration
 * (`"@slkiser/opencode-quota@X"` in its plugin list), if any. The file is
 * JSONC, so it is searched rather than parsed.
 */
export function pinnedQuotaVersion(home = homedir(), env: Record<string, string | undefined> = process.env): string | undefined {
  const dir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const match = /"@slkiser\/opencode-quota@([^"\s]+)"/.exec(text);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The installed opencode-quota CLI script: the version `pinned` (the one
 * OpenCode loads) when it's installed, else the newest. Another version's
 * cache can be empty.
 */
export function findQuotaCli(home = homedir(), pinned = pinnedQuotaVersion(home)): string | undefined {
  const packages = join(home, ".cache", "opencode", "packages", "@slkiser");
  let names: string[];
  try {
    names = readdirSync(packages);
  } catch {
    return undefined;
  }
  const script = (dir: string): string => join(packages, dir, "node_modules", QUOTA_PACKAGE, "dist", "bin", "opencode-quota.js");
  if (pinned !== undefined && existsSync(script(`opencode-quota@${pinned}`))) return script(`opencode-quota@${pinned}`);
  const scripts = names
    .map((name) => /^opencode-quota@(.+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => compareVersions(a[1]!, b[1]!))
    .map((match) => script(match[0]))
    .filter((path) => existsSync(path));
  return scripts.at(-1);
}

/** A JavaScript runtime to run the quota CLI with: this one, unless it is OpenCode's own executable. */
export function javaScriptRuntime(home = homedir()): string {
  if (/(^|\/)(bun|node)(\.exe)?$/.test(process.execPath)) return process.execPath;
  const bun = join(home, ".bun", "bin", "bun");
  return Bun.which("bun") ?? Bun.which("node") ?? bun;
}

/** The quota JSON from `file`, or from the quota CLI when there is no file. */
export async function readQuotaJson(file?: string, home = homedir()): Promise<{ json?: unknown; reason?: string }> {
  if (file !== undefined) {
    try {
      return { json: JSON.parse(readFileSync(file, "utf8")) };
    } catch (error) {
      return { reason: `${file} unreadable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const script = findQuotaCli(home);
  if (!script) return { reason: "opencode-quota CLI not found" };
  let child;
  try {
    child = Bun.spawn([javaScriptRuntime(home), script, "show", "--json"], { stdout: "pipe", stderr: "ignore" });
  } catch (error) {
    return { reason: `opencode-quota could not start: ${error instanceof Error ? error.message : String(error)}` };
  }
  const timer = setTimeout(() => child.kill(), QUOTA_TIMEOUT_MS);
  const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  if (child.signalCode) return { reason: `opencode-quota timed out after ${QUOTA_TIMEOUT_MS / 1000} s` };
  if (status !== 0) return { reason: `opencode-quota failed with status ${status}` };
  try {
    return { json: JSON.parse(stdout) };
  } catch {
    return { reason: "opencode-quota printed invalid JSON" };
  }
}

/** The quota for the configured providers, with a warning and unknown spares when it can't be read. */
export async function loadQuota(config: Config, now: Date, file?: string): Promise<Quota> {
  const { json, reason } = await readQuotaJson(file);
  if (json === undefined) {
    const quota = unknownQuota(config, "quota data unavailable");
    quota.warnings.push(`quota data unavailable (${reason}); spare unknown`);
    return quota;
  }
  return computeQuota(json, config, now);
}
