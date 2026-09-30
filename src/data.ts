// The data file: one CSV row per model and effort, with any number of numeric
// columns. Which columns matter is up to the configuration (`columns.use`).

import { CsvError, parseCsv } from "./csv.ts";
import { readText, show, ValidationError } from "./validate.ts";

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

/** Columns every data file has, with a fixed meaning; `date` is optional. */
export const FIXED_COLUMNS = ["model", "vendor", "effort", "date"] as const;

/**
 * A model ID as compared everywhere: lowercase, with `.` and `-` equal, so
 * `claude-opus-5-5` matches `claude-opus-5.5`.
 */
export function normalizeId(id: string): string {
  return id.trim().toLowerCase().replaceAll(".", "-");
}

export interface Row {
  /** The model ID, as written in the data. */
  model: string;
  vendor: string;
  effort: Effort;
  date?: string;
  /** The used columns' values; every used column has one. */
  values: Record<string, number>;
  /** The physical line of the row in the file. */
  line: number;
}

export interface Data {
  /** The columns of the header, in order. */
  columns: string[];
  rows: Row[];
  /** The oldest `date` in the data, if it has dates. */
  snapshot?: string;
}

/** Every problem found in the data, one message each. */
export class DataError extends ValidationError {
  constructor(messages: string[]) {
    super(messages);
    this.name = "DataError";
  }
}

const fail = (messages: string[]): Error => new DataError(messages);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `text` is a real calendar date as YYYY-MM-DD: 2000-02-30 is not. */
function isDate(text: string): boolean {
  if (!DATE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/** A finite number written in plain decimal or exponent notation, or undefined. */
function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parses and validates a data file. `use` lists the columns that must hold a
 * number in every row; without it, every column besides the fixed ones must.
 * `label` prefixes the messages, as `label:line: ...`.
 */
export function parseData(text: string, label: string, use?: readonly string[]): Data {
  const errors: string[] = [];
  const at = (line: number, message: string): void => {
    errors.push(`${label}:${line}: ${message}`);
  };

  let records;
  try {
    records = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvError) throw new DataError([`${label}:${error.line}: CSV syntax error: ${error.message}`]);
    throw error;
  }
  const [header, ...body] = records;
  if (header === undefined) throw new DataError([`${label}: empty file, expected a header row`]);

  const columns = header.fields.map((name) => name.trim());
  const seen = new Set<string>();
  for (const name of columns) {
    if (name === "") at(header.line, "empty column name in the header");
    else if (seen.has(name)) at(header.line, `duplicate column ${show(name)}`);
    seen.add(name);
  }
  for (const required of ["model", "vendor", "effort"]) {
    if (!columns.includes(required)) at(header.line, `missing column ${show(required)}`);
  }
  const numeric = use ?? columns.filter((name) => !(FIXED_COLUMNS as readonly string[]).includes(name) && name !== "");
  for (const name of numeric) {
    if ((FIXED_COLUMNS as readonly string[]).includes(name)) at(header.line, `column ${show(name)} is not numeric and can't be used`);
    else if (!columns.includes(name)) at(header.line, `missing column ${show(name)}, which the configuration uses`);
  }
  if (errors.length > 0) throw new DataError(errors);

  const index = (name: string): number => columns.indexOf(name);
  const rows: Row[] = [];
  const keys = new Map<string, number>();
  const vendors = new Map<string, { vendor: string; line: number }>();
  let snapshot: string | undefined;

  for (const record of body) {
    const { line, fields } = record;
    if (fields.length !== columns.length) {
      at(line, `${fields.length} fields, but the header has ${columns.length}`);
      continue;
    }
    const cell = (name: string): string => fields[index(name)]!.trim();
    let ok = true;

    const model = cell("model");
    if (model === "") {
      at(line, "empty model");
      ok = false;
    }
    const vendor = cell("vendor");
    if (vendor === "") {
      at(line, "empty vendor");
      ok = false;
    }
    const effort = cell("effort");
    if (!isEffort(effort)) {
      at(line, `unknown effort ${show(effort)}; the known efforts are: ${EFFORTS.join(", ")}`);
      ok = false;
    }
    let date: string | undefined;
    if (columns.includes("date")) {
      const text = cell("date");
      if (text !== "" && !isDate(text)) {
        at(line, `date ${show(text)} is not YYYY-MM-DD`);
        ok = false;
      } else if (text !== "") date = text;
    }
    const values: Record<string, number> = {};
    for (const name of numeric) {
      const text = cell(name);
      const value = parseNumber(text);
      if (value === undefined) {
        at(line, text === "" ? `empty ${name}` : `${name} ${show(text)} is not a finite number`);
        ok = false;
      } else values[name] = value;
    }

    if (model !== "") {
      const key = normalizeId(model);
      if (vendor !== "") {
        const first = vendors.get(key);
        if (first === undefined) vendors.set(key, { vendor, line });
        else if (first.vendor !== vendor) {
          at(line, `model ${show(model)} has vendor ${show(vendor)}, but ${show(first.vendor)} on line ${first.line}`);
          ok = false;
        }
      }
      if (isEffort(effort)) {
        const rowKey = `${key}\0${effort}`;
        const previous = keys.get(rowKey);
        if (previous !== undefined) {
          at(line, `duplicate row for model ${show(model)} at effort ${effort}, first on line ${previous}`);
          ok = false;
        } else keys.set(rowKey, line);
      }
    }

    if (!ok) continue;
    if (date !== undefined && (snapshot === undefined || date < snapshot)) snapshot = date;
    rows.push({ model, vendor, effort: effort as Effort, ...(date ? { date } : {}), values, line });
  }

  if (errors.length > 0) throw new DataError(errors);
  if (rows.length === 0) throw new DataError([`${label}: no rows`]);
  return { columns, rows, ...(snapshot ? { snapshot } : {}) };
}

/** Reads the data file at `path`; `label` prefixes the error. */
export function readDataText(path: string, label = path): string {
  return readText(path, label, fail);
}

/** Reads, parses and validates the data file at `path`; see `parseData`. */
export function loadData(path: string, use?: readonly string[], label = path): Data {
  return parseData(readDataText(path, label), label, use);
}

/** The distinct models of the data, by normalized ID, in order of appearance. */
export function dataModels(data: Data): Map<string, { model: string; vendor: string }> {
  const models = new Map<string, { model: string; vendor: string }>();
  for (const row of data.rows) {
    const key = normalizeId(row.model);
    if (!models.has(key)) models.set(key, { model: row.model, vendor: row.vendor });
  }
  return models;
}

/** A window length in seconds, or "monthly" for the calendar month. */
export type WindowLength = number | "monthly";

/** Parses `<N>h`, `<N>d`, `daily`, `weekly` or `monthly`, case-insensitively. */
export function parseWindowLength(text: string): WindowLength | undefined {
  const lower = text.trim().toLowerCase();
  const match = /^(\d+)([hd])$/.exec(lower);
  if (match) {
    const count = Number(match[1]);
    if (count === 0) return undefined;
    return count * (match[2] === "h" ? 3600 : 86400);
  }
  if (lower === "daily") return 86400;
  if (lower === "weekly") return 7 * 86400;
  if (lower === "monthly") return "monthly";
  return undefined;
}
