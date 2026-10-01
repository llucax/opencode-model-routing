// The configuration's formulas and predicates against the data: which
// columns they use, whether their names exist, their values for every row,
// and the columns a request shows.

import type { Config } from "./config.ts";
import { FIXED_COLUMNS, type Data, type Row } from "./data.ts";
import { evaluate, type Expr } from "./expr.ts";
import type { Request } from "./request.ts";
import { show } from "./validate.ts";

/** An expression and where it's written: a configuration key such as `policy.cheap`, or an option such as `--where`. */
export interface Located {
  key: string;
  expr: Expr;
}

/** Every formula and predicate in the configuration, with its key. */
export function configExpressions(config: Config): Located[] {
  const found: Located[] = Object.entries(config.formulas).map(([name, expr]) => ({ key: `formulas.${name}`, expr }));
  if (config.policy.cheap) found.push({ key: "policy.cheap", expr: config.policy.cheap });
  if (config.policy.heavy) found.push({ key: "policy.heavy", expr: config.policy.heavy });
  for (const provider of Object.values(config.providers)) {
    if (provider.bounded) found.push({ key: `providers.${provider.name}.bounded`, expr: provider.bounded });
    if (provider.heavy) found.push({ key: `providers.${provider.name}.heavy`, expr: provider.heavy });
  }
  for (const job of Object.values(config.jobs)) {
    if (job.value) found.push({ key: `jobs.${job.name}.value`, expr: job.value });
    if (job.where) found.push({ key: `jobs.${job.name}.where`, expr: job.where });
  }
  return found;
}

/** The data columns an expression uses, through the formulas it refers to too. */
export function columnsOf(expr: Expr, config: Config, seen = new Set<string>()): Set<string> {
  const columns = new Set<string>();
  for (const { name } of expr.names) {
    const formula = config.formulas[name];
    if (formula === undefined) columns.add(name);
    else if (!seen.has(name)) {
      seen.add(name);
      for (const column of columnsOf(formula, config, seen)) columns.add(column);
    }
  }
  return columns;
}

/**
 * The data columns routing reads, each of which must hold a number in every
 * row: those every formula and predicate refers to, `columns.include`, and
 * those of `extra`.
 */
export function usedColumns(config: Config, extra: readonly Located[] = []): string[] {
  const used = new Set(config.columns.include);
  for (const { expr } of [...configExpressions(config), ...extra]) {
    for (const column of columnsOf(expr, config)) used.add(column);
  }
  return [...used];
}

/**
 * Problems with the names the configuration and `extra` use, against the
 * data's header: formulas named like a data column, names that are neither a
 * column nor a formula, and included columns the data lacks. `label`
 * prefixes the configuration's messages; `extra`'s keys are their own label.
 */
export function checkColumns(config: Config, columns: readonly string[], label: string, extra: readonly Located[] = []): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(config.formulas)) {
    if (columns.includes(name)) {
      problems.push(`${label}: formulas.${name}: ${show(name)} is also a data column; rename the formula or the column`);
    }
  }
  config.columns.include.forEach((name, i) => {
    if (!columns.includes(name)) problems.push(`${label}: columns.include[${i}]: unknown column ${show(name)}, not in the data`);
  });
  const check = (where: string, expr: Expr): void => {
    for (const { name, column } of expr.names) {
      if (name in config.formulas || columns.includes(name)) continue;
      problems.push(`${where}: column ${column}: unknown name ${show(name)}, neither a data column nor a formula`);
    }
  };
  for (const { key, expr } of configExpressions(config)) check(`${label}: ${key}`, expr);
  for (const { key, expr } of extra) check(key, expr);
  return problems;
}

/** Each row's value of every formula and predicate, the configuration's and the extra ones, by expression text. */
export type Results = Map<Row, Map<string, number | boolean>>;

/** The named formulas in an order where each comes after those it refers to; the configuration has no cycles. */
function formulaOrder(config: Config): string[] {
  const order: string[] = [];
  const visit = (name: string): void => {
    if (order.includes(name)) return;
    for (const ref of config.formulas[name]!.names) if (ref.name in config.formulas && ref.name !== name) visit(ref.name);
    order.push(name);
  };
  for (const name of Object.keys(config.formulas)) visit(name);
  return order;
}

/**
 * Evaluates every formula and predicate of the configuration, and `extra`,
 * for every row. A non-finite number is a problem naming the row as
 * `file:line`, the key and the column in the expression; every one is
 * reported.
 */
export function evaluateRows(
  config: Config,
  data: Data,
  dataLabel: string,
  extra: readonly Located[] = [],
): { results: Results; problems: string[] } {
  const results: Results = new Map();
  const problems: string[] = [];
  const order = formulaOrder(config);
  const others = [...configExpressions(config).filter((entry) => !entry.key.startsWith("formulas.")), ...extra];
  for (const row of data.rows) {
    const values = new Map<string, number | boolean>();
    const formulaValues = new Map<string, number | undefined>();
    const lookup = (name: string): number | undefined => (formulaValues.has(name) ? formulaValues.get(name) : row.values[name]);
    const run = (key: string, expr: Expr): number | boolean | undefined => {
      const result = evaluate(expr, lookup);
      for (const problem of result.problems) problems.push(`${dataLabel}:${row.line}: ${key}: column ${problem.column}: ${problem.message}`);
      if (result.value !== undefined) values.set(expr.text, result.value);
      return result.value;
    };
    for (const name of order) formulaValues.set(name, run(`formulas.${name}`, config.formulas[name]!) as number | undefined);
    for (const { key, expr } of others) run(key, expr);
    results.set(row, values);
  }
  return { results, problems };
}

/** A formula's value at a row; every row has one once evaluation found no problems. */
export function numberAt(results: Results, row: Row, expr: Expr): number {
  const value = results.get(row)?.get(expr.text);
  if (typeof value !== "number") throw new Error(`no value for "${expr.text}" at line ${row.line}`);
  return value;
}

/** A predicate's value at a row; an absent predicate is false. */
export function truthAt(results: Results, row: Row, expr: Expr | undefined): boolean {
  if (expr === undefined) return false;
  const value = results.get(row)?.get(expr.text);
  if (typeof value !== "boolean") throw new Error(`no value for "${expr.text}" at line ${row.line}`);
  return value;
}

/** What a request shows besides the value: data columns in the data's order, and score and cost when they aren't a bare column. */
export interface Shown {
  columns: string[];
  score: boolean;
  cost: boolean;
}

/** Whether a formula is a bare data column. */
function isBareColumn(expr: Expr, config: Config): boolean {
  return expr.node.kind === "name" && !(expr.node.name in config.formulas);
}

/**
 * The columns a request shows: `columns.include` and those the request's
 * score, cost, value and where use, in the data's order; plus the score and
 * the cost of their own when their formula isn't a bare column.
 */
export function shownColumns(request: Request, config: Config, data: Data): Shown {
  const wanted = new Set(config.columns.include);
  for (const expr of [config.formulas.score!, config.formulas.cost!, request.value, ...(request.where ? [request.where] : [])]) {
    for (const column of columnsOf(expr, config)) wanted.add(column);
  }
  return {
    columns: data.columns.filter((column) => wanted.has(column) && !(FIXED_COLUMNS as readonly string[]).includes(column)),
    score: !isBareColumn(config.formulas.score!, config),
    cost: !isBareColumn(config.formulas.cost!, config),
  };
}
