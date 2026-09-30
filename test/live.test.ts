import { describe, expect, test } from "bun:test";
import { liveCatalog, runningSessions } from "../src/live.ts";

type Client = Parameters<typeof liveCatalog>[0];
const asClient = (value: object): Client => value as unknown as Client;

describe("live provider catalog", () => {
  test("connected providers' variant keys become efforts and image input sets vision", async () => {
    const calls: unknown[] = [];
    const client = asClient({ config: { providers: async (options: unknown) => {
      calls.push(options);
      return { data: { providers: [
        { id: "alpha", models: {
          "acme-big": { variants: { low: {}, high: {}, xhigh: {} }, capabilities: { input: { text: true, image: true } } },
          "acme-small": { variants: { none: {} }, capabilities: { input: { image: false } } },
        } },
        { id: "beta", models: { "no-variants": { capabilities: { input: { image: true } } },
          "bad-variants": { variants: ["high"], capabilities: {} } } },
      ] } };
    } } });
    expect(await liveCatalog(client)).toEqual({ source: "OpenCode's connected providers", providers: {
      alpha: { "acme-big": { efforts: ["low", "high", "xhigh"], vision: true },
        "acme-small": { efforts: ["none"], vision: false } },
      beta: { "no-variants": { efforts: [], vision: true }, "bad-variants": { efforts: [], vision: false } },
    } });
    expect(calls).toEqual([{ throwOnError: true }]);
  });
});

describe("running sessions across directories", () => {
  const now = Date.UTC(2000, 0, 10);
  const listed = [
    { id: "busy", directory: "/one", model: { providerID: "alpha", id: "acme-big", variant: "high" } },
    { id: "retry", directory: "/two", model: { providerID: "beta", id: "zed-pro", variant: "default" } },
    { id: "idle", directory: "/one", model: { providerID: "alpha", id: "acme-small", variant: "low" } },
    { id: "unknown-model", directory: "/two", model: { providerID: "beta" } },
    { id: "no-model", directory: "/two" },
  ];

  test("raw GET bypasses directory filter and asks status once per directory", async () => {
    const gets: unknown[] = [];
    const statusQueries: unknown[] = [];
    const client = asClient({
      _client: { get: async (options: unknown) => { gets.push(options); return { data: listed }; } },
      session: {
        list: async () => { throw new Error("fallback should not run"); },
        status: async (options: { query: { directory: string } }) => {
          statusQueries.push(options);
          return { data: options.query.directory === "/one"
            ? { busy: { type: "busy" }, idle: { type: "idle" } }
            : { retry: { type: "retry" }, "unknown-model": { type: "busy" }, "no-model": { type: "busy" } } };
        },
      },
    });
    const result = await runningSessions(client, now);
    expect(gets).toEqual([{ url: "/experimental/session", query: { directory: "", start: now - 24 * 3600 * 1000, limit: 1000 }, throwOnError: true }]);
    expect(statusQueries).toEqual([
      { query: { directory: "/one" }, throwOnError: true },
      { query: { directory: "/two" }, throwOnError: true },
    ]);
    expect(result).toEqual({ warnings: [], sessions: [
      { id: "busy", directory: "/one", model: { providerID: "alpha", modelID: "acme-big", variant: "high" } },
      { id: "retry", directory: "/two", model: { providerID: "beta", modelID: "zed-pro" } },
      { id: "unknown-model", directory: "/two" },
      { id: "no-model", directory: "/two" },
    ] });
  });

  test("failed raw GET uses session.list and warns that other directories were not seen", async () => {
    const calls: unknown[] = [];
    const client = asClient({
      _client: { get: async () => { throw new Error("offline experimental endpoint"); } },
      session: {
        list: async (options: unknown) => { calls.push(["list", options]); return { data: [listed[0], listed[2]] }; },
        status: async (options: unknown) => { calls.push(["status", options]); return { data: { busy: { type: "busy" }, idle: { type: "idle" } } }; },
      },
    });
    expect(await runningSessions(client, now)).toEqual({
      warnings: ["sessions of other directories not seen (offline experimental endpoint)"],
      sessions: [{ id: "busy", directory: "/one", model: { providerID: "alpha", modelID: "acme-big", variant: "high" } }],
    });
    expect(calls).toEqual([
      ["list", { throwOnError: true }],
      ["status", { query: { directory: "/one" }, throwOnError: true }],
    ]);
  });

  test("unexpected response from raw GET falls back with a warning", async () => {
    const client = asClient({
      _client: { get: async () => ({ data: {} }) },
      session: { list: async () => ({ data: [] }), status: async () => { throw new Error("no statuses needed"); } },
    });
    expect(await runningSessions(client, now)).toEqual({
      sessions: [], warnings: ["sessions of other directories not seen (unexpected /experimental/session response)"],
    });
  });
});
