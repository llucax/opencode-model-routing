import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildRouting, parseConfig, type Routing } from "../src/config.ts";
import type { Located } from "../src/formulas.ts";
import { loadModelsJson } from "../src/catalog.ts";
import { unknownQuota } from "../src/quota.ts";
import { buildRequest, type RequestInput } from "../src/request.ts";
import { route, type RouteInputs } from "../src/route.ts";

export const fixtureDir = join(import.meta.dir, "fixtures");
export const fixtureModels = join(fixtureDir, "models.csv");
export const fixtureText = await Bun.file(fixtureModels).text();
export const fixtureConfig = join(fixtureDir, "config.toml");
export const fixtureConfigText = await Bun.file(fixtureConfig).text();
export const fixtureCatalog = loadModelsJson(join(fixtureDir, "models.json"));

/** Parse the synthetic CSV and config together, checking cross-file references and evaluating the formulas. */
export function routing(dataText = fixtureText, configText = fixtureConfigText, extra: Located[] = []): Routing {
  return buildRouting(parseConfig(configText, "config.toml", fixtureConfig), dataText, "config.toml", "models.csv", extra);
}

/** The request's own value and where, as the CLI passes them to loading. */
function extraOf(input: RequestInput): Located[] {
  return [
    ...(input.value ? [{ key: "--value", expr: input.value }] : []),
    ...(input.where ? [{ key: "--where", expr: input.where }] : []),
  ];
}

export const fixtureData = routing;

export function routeFixture(input: RequestInput = {}, overrides: Partial<RouteInputs> = {}) {
  const selected = overrides.routing ?? routing(fixtureText, fixtureConfigText, extraOf(input));
  return route(buildRequest(input, selected.config, 0), {
    routing: selected, catalog: fixtureCatalog, quota: unknownQuota(selected.config, "test"), ...overrides,
  });
}

export function edited(from: string, to: string): string {
  if (!fixtureText.includes(from)) throw new Error(`fixture does not contain ${from}`);
  return fixtureText.replace(from, to);
}

export function editedConfig(from: string, to: string): string {
  if (!fixtureConfigText.includes(from)) throw new Error(`fixture config does not contain ${from}`);
  return fixtureConfigText.replace(from, to);
}

/** A new temporary directory, as a path. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "model-route-test-"));
}

export function writeFiles(dir: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

export function configOnly(...names: string[]): string {
  const [head, ...blocks] = fixtureConfigText.split(/\n(?=\[providers\.)/);
  // Keep the later global tags, jobs and model entries, not only provider blocks.
  const tail = blocks.pop()!;
  const marker = tail.indexOf("\n[tags]");
  const provider = tail.slice(0, marker);
  const suffix = tail.slice(marker).replace(/^ids = \{ (.*?) \}$/gm, (_line, entries: string) => {
    const keptIds = entries.split(", ").filter((entry) => names.includes(entry.split(" = ")[0]!));
    return keptIds.length > 0 ? `ids = { ${keptIds.join(", ")} }` : "";
  });
  const kept = [...blocks, provider].filter((block) => names.some((name) => block.startsWith(`[providers.${name}]`)));
  return `${head!.replace(/prefer = \[.*\]/, `prefer = ${JSON.stringify(names)}`)}\n${kept.join("\n")}\n${suffix}`;
}

export function cliEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: tempDir() };
  delete env.MODEL_ROUTING_CONFIG;
  delete env.XDG_CONFIG_HOME;
  return { ...env, ...extra };
}
