// What the routing data and the configuration file share: their TOML
// parsing, reading and strict validation, which collect every problem.

import { readFileSync } from "node:fs";

/** Every problem found in a file, one message each. */
export class ValidationError extends Error {
  constructor(readonly messages: string[]) {
    super(messages.join("\n"));
    this.name = "ValidationError";
  }
}

/** Reads the file at `path`; `label` prefixes the error, made by `fail`. */
export function readText(path: string, label: string, fail: (messages: string[]) => Error): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : String(error);
    throw fail([`${label}: cannot read: ${reason}`]);
  }
}

/** Parses TOML; a syntax error is one message with its line, made into an error by `fail`. */
export function parseToml(text: string, label: string, fail: (messages: string[]) => Error): unknown {
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    const position = (error as { position?: { line?: number } }).position;
    const message = error instanceof Error ? error.message : String(error);
    const line = position?.line ? ` at line ${position.line}` : "";
    throw fail([`${label}: TOML syntax error${line}: ${message}`]);
  }
}

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** The location of `key` inside `where`: `model "X" rows[1].effort`, `policy.prefer`. */
export function path(where: string, key: string): string {
  if (where === "") return key;
  return /^model (\[\d+\]|".*")$/.test(where) ? `${where} ${key}` : `${where}.${key}`;
}

export class Validator {
  readonly errors: string[] = [];

  constructor(readonly label: string) {}

  error(where: string, message: string): void {
    this.errors.push(`${this.label}: ${where ? `${where}: ` : ""}${message}`);
  }

  /** The value as a table, or undefined after reporting it isn't one. */
  table(value: unknown, where: string): Obj | undefined {
    if (isObj(value)) return value;
    this.error(where, "must be a table");
    return undefined;
  }

  /** Reports every key of the table that isn't allowed. */
  keys(table: Obj, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(table)) {
      if (!allowed.includes(key)) this.error(where, `unknown key ${show(key)}`);
    }
  }

  string(table: Obj, key: string, where: string, required = true): string | undefined {
    const value = table[key];
    const at = path(where, key);
    if (value === undefined) {
      if (required) this.error(where, `missing ${show(key)}`);
      return undefined;
    }
    if (typeof value !== "string") {
      this.error(at, "must be a string");
      return undefined;
    }
    return value;
  }

  nonEmptyString(table: Obj, key: string, where: string): string | undefined {
    const value = this.string(table, key, where);
    if (value !== undefined && value.trim() === "") {
      this.error(path(where, key), "must not be empty");
      return undefined;
    }
    return value;
  }

  number(table: Obj, key: string, where: string, min?: "non-negative" | "positive"): number | undefined {
    const value = table[key];
    const at = path(where, key);
    if (value === undefined) {
      this.error(where, `missing ${show(key)}`);
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.error(at, "must be a number");
      return undefined;
    }
    if (min === "non-negative" && value < 0) {
      this.error(at, `must not be negative, got ${value}`);
      return undefined;
    }
    if (min === "positive" && value <= 0) {
      this.error(at, `must be positive, got ${value}`);
      return undefined;
    }
    return value;
  }

  /** The value as an array of strings, or undefined after reporting a problem. */
  strings(table: Obj, key: string, where: string, required = true): string[] | undefined {
    const value = table[key];
    const at = path(where, key);
    if (value === undefined) {
      if (required) this.error(where, `missing ${show(key)}`);
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.error(at, "must be an array of strings");
      return undefined;
    }
    let ok = true;
    value.forEach((item, index) => {
      if (typeof item !== "string") {
        this.error(`${at}[${index}]`, "must be a string");
        ok = false;
      }
    });
    return ok ? (value as string[]) : undefined;
  }

  /** An array of tables, or undefined after reporting a problem. */
  tables(table: Obj, key: string, where: string, required = true): Obj[] | undefined {
    const value = table[key];
    const at = path(where, key);
    if (value === undefined) {
      if (required) this.error(where, `missing ${show(key)}`);
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.error(at, "must be an array of tables");
      return undefined;
    }
    let ok = true;
    for (const [index, item] of value.entries()) {
      if (!isObj(item)) {
        this.error(`${at}[${index}]`, "must be a table");
        ok = false;
      }
    }
    return ok ? (value as Obj[]) : undefined;
  }
}
