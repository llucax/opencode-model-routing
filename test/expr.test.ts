import { describe, expect, test } from "bun:test";
import { compile, evaluate, ExprError, isName, names, parse, typeOf, type ExprType } from "../src/expr.ts";

/** The value of a constant expression, or of one over `vars`. */
function value(text: string, vars: Record<string, number> = {}, type?: ExprType): number | boolean | undefined {
  const node = parse(text);
  const expr = compile(text, type ?? typeOf(node));
  const result = evaluate(expr, (name) => vars[name]);
  expect(result.problems).toEqual([]);
  return result.value;
}

/** The error of compiling `text`, as `column N: message`. */
function error(text: string, type: ExprType = "number"): string {
  try {
    compile(text, type);
  } catch (caught) {
    if (caught instanceof ExprError) return `column ${caught.column}: ${caught.message}`;
    throw caught;
  }
  throw new Error(`expected an error for ${text}`);
}

describe("parsing and precedence", () => {
  test("numbers: integers, fractions and exponents", () => {
    expect(value("42")).toBe(42);
    expect(value("0.5")).toBe(0.5);
    expect(value("1e3")).toBe(1000);
    expect(value("2.5E-1")).toBe(0.25);
  });
  test("arithmetic precedence and left associativity", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("10 - 4 - 3")).toBe(3);
    expect(value("8 / 4 / 2")).toBe(1);
    expect(value("2 * 3 / 4")).toBe(1.5);
  });
  test("power is right-associative and binds tighter than a leading minus", () => {
    expect(value("2 ^ 3 ^ 2")).toBe(512);
    expect(value("-2^2")).toBe(-4);
    expect(value("(-2)^2")).toBe(4);
    expect(value("2^-2")).toBe(0.25);
    expect(value("2 * 3 ^ 2")).toBe(18);
    expect(value("- -3")).toBe(3);
    expect(value("1 - -3")).toBe(4);
  });
  test("functions", () => {
    expect(value("log(1)")).toBe(0);
    expect(value("log2(8)")).toBe(3);
    expect(value("log10(1000)")).toBe(3);
    expect(value("sqrt(16)")).toBe(4);
    expect(value("abs(-3)")).toBe(3);
    expect(value("min(3, 1, 2)")).toBe(1);
    expect(value("max(3, 1 + 4)")).toBe(5);
    expect(value("max(min(1, 2), -log2(0.25))")).toBe(2);
  });
  test("names, with their columns", () => {
    expect(value("score - 60 * log2(cost)", { score: 700, cost: 4 })).toBe(580);
    expect(value("_a1 + B_2", { _a1: 1, B_2: 2 })).toBe(3);
    expect(names(parse("a + f(b, c) * a"))).toEqual([
      { name: "a", column: 1 },
      { name: "b", column: 7 },
      { name: "c", column: 10 },
      { name: "a", column: 15 },
    ]);
  });
  test("comparisons and their combinations", () => {
    expect(value("1 < 2")).toBe(true);
    expect(value("2 <= 2")).toBe(true);
    expect(value("1 > 2")).toBe(false);
    expect(value("2 >= 3")).toBe(false);
    expect(value("2 == 2")).toBe(true);
    expect(value("2 != 2")).toBe(false);
    expect(value("1 + 1 == 2 * 1")).toBe(true);
  });
  test("not binds looser than a comparison, and tighter than and, which binds tighter than or", () => {
    expect(value("not 1 < 2")).toBe(false);
    expect(value("not not 1 < 2")).toBe(true);
    expect(value("1 > 2 and 1 > 2 or 1 < 2")).toBe(true);
    expect(value("1 < 2 or 1 < 2 and 1 > 2")).toBe(true);
    expect(value("(1 < 2 or 1 < 2) and 1 > 2")).toBe(false);
    expect(value("not 1 > 2 and 1 > 2")).toBe(false);
    expect(value("not (1 > 2 and 1 > 2)")).toBe(true);
  });
  test("whitespace is free, including none and newlines", () => {
    expect(value("1+2*3")).toBe(7);
    expect(value(" 1 +\n\t2 ")).toBe(3);
    expect(value("cost<=1", { cost: 1 })).toBe(true);
  });
  test("names are identifiers that aren't keywords", () => {
    expect(isName("cost_per_task")).toBe(true);
    expect(isName("_x9")).toBe(true);
    expect(isName("9x")).toBe(false);
    expect(isName("cost-per-task")).toBe(false);
    expect(isName("and")).toBe(false);
    expect(isName("not")).toBe(false);
  });
});

describe("syntax errors, with the column of the problem", () => {
  test("empty, unfinished and trailing input", () => {
    expect(error("")).toBe("column 1: empty expression");
    expect(error("   ")).toBe("column 1: empty expression");
    expect(error("1 +")).toBe("column 4: unexpected end of the expression, expected a number, a name or \"(\"");
    expect(error("(1 + 2")).toBe('column 7: unexpected end of the expression, expected ")"');
    expect(error("1 2")).toBe('column 3: unexpected "2", expected an operator or the end');
    expect(error("a b")).toBe('column 3: unexpected "b", expected an operator or the end');
    expect(error("1 + 2)")).toBe('column 6: unexpected ")", expected an operator or the end');
    expect(error("max(1, 2")).toBe('column 9: unexpected end of the expression, expected "," or ")"');
    expect(error("max(1,)")).toBe('column 7: unexpected ")", expected a number, a name or "("');
    expect(error("()")).toBe('column 2: unexpected ")", expected a number, a name or "("');
  });
  test("characters and numbers the language doesn't have", () => {
    expect(error("a.b")).toBe('column 2: unexpected character "."');
    expect(error("a = 1", "truth")).toBe('column 3: unexpected character "="; use "==" to compare');
    expect(error("a && b", "truth")).toBe('column 3: unexpected character "&"; use "and", "or" and "not"');
    expect(error("!a", "truth")).toBe('column 1: unexpected character "!"; use "and", "or" and "not"');
    expect(error("a % 2")).toBe('column 3: unexpected character "%"');
    expect(error("1.")).toBe('column 1: malformed number "1."');
    expect(error("2x")).toBe('column 1: malformed number "2x"');
    expect(error("1e")).toBe('column 1: malformed number "1e"');
    expect(error(".5")).toBe('column 1: unexpected character "."');
    expect(error("1e999")).toBe("column 1: number 1e999 is too large");
    expect(error("a[0]")).toBe('column 2: unexpected character "["');
  });
  test("keywords can't be names", () => {
    expect(error("and + 1")).toBe('column 1: unexpected "and", expected a number, a name or "("');
    expect(error("1 + or")).toBe('column 5: unexpected "or", expected a number, a name or "("');
  });
  test("comparisons don't chain", () => {
    expect(error("a < b < c", "truth")).toBe('column 7: comparisons can\'t be chained; join them with "and"');
    expect(error("1 == 1 != 0", "truth")).toBe('column 8: comparisons can\'t be chained; join them with "and"');
    expect(value("1 < 2 and 2 < 3")).toBe(true);
  });
  test("unknown functions and wrong argument counts", () => {
    expect(error("exp(1)")).toBe('column 1: unknown function "exp"; the functions are log, log2, log10, sqrt, abs, min, max');
    expect(error("1 + log(1, 2)")).toBe("column 5: log() takes 1 argument, got 2");
    expect(error("min(1)")).toBe("column 1: min() takes at least 2 arguments, got 1");
  });
});

describe("types", () => {
  test("a formula must give a number", () => {
    expect(error("cost <= 0.5")).toBe("column 6: a formula must give a number, this is a comparison");
    expect(error("a < 1 and b < 2")).toBe("column 7: a formula must give a number, this is a combination of comparisons");
    expect(error("not a < 1")).toBe("column 1: a formula must give a number, this is a combination of comparisons");
  });
  test("a predicate must give a truth value", () => {
    expect(error("cost", "truth")).toBe("column 1: a predicate must be a comparison or a combination of them, this is a number");
    expect(error("cost * 2", "truth")).toBe("column 6: a predicate must be a comparison or a combination of them, this is a number");
  });
  test("arithmetic, functions and comparisons take numbers", () => {
    expect(error("(a < 1) + 1")).toBe('column 4: "+" takes numbers, not a comparison');
    expect(error("1 * (a < 1 or b < 1)")).toBe('column 12: "*" takes numbers, not a combination of comparisons');
    expect(error("-(a < 1)")).toBe('column 5: "-" takes numbers, not a comparison');
    expect(error("max(a < 1, 2)")).toBe("column 7: max() takes numbers, not a comparison");
    expect(error("(a < 1) == (b < 1)", "truth")).toBe('column 4: "==" takes numbers, not a comparison');
  });
  test("and, or and not take truth values", () => {
    expect(error("a and b < 1", "truth")).toBe('column 1: "and" takes comparisons or combinations of them, not a number');
    expect(error("a < 1 or b", "truth")).toBe('column 10: "or" takes comparisons or combinations of them, not a number');
    expect(error("not a", "truth")).toBe('column 5: "not" takes comparisons or combinations of them, not a number');
  });
  test("compile keeps the text, the type and the names", () => {
    const expr = compile("score >= 780 and cost < 5", "truth");
    expect(expr).toMatchObject({ text: "score >= 780 and cost < 5", type: "truth" });
    expect(expr.names).toEqual([
      { name: "score", column: 1 },
      { name: "cost", column: 18 },
    ]);
  });
});

describe("evaluation", () => {
  const run = (text: string, vars: Record<string, number | undefined>, type: ExprType = "number") =>
    evaluate(compile(text, type), (name) => vars[name]);

  test("non-finite results are problems where they first appear", () => {
    expect(run("1 + log(x)", { x: 0 })).toEqual({ problems: [{ column: 5, message: "log() gives -Infinity" }] });
    expect(run("2 * (a / b)", { a: 1, b: 0 })).toEqual({ problems: [{ column: 8, message: '"/" gives Infinity' }] });
    expect(run("0 / x", { x: 0 })).toEqual({ problems: [{ column: 3, message: '"/" gives NaN' }] });
    expect(run("sqrt(x)", { x: -1 })).toEqual({ problems: [{ column: 1, message: "sqrt() gives NaN" }] });
    expect(run("10 ^ x", { x: 400 })).toEqual({ problems: [{ column: 4, message: '"^" gives Infinity' }] });
    expect(run("x * x", { x: 1e200 })).toEqual({ problems: [{ column: 3, message: '"*" gives Infinity' }] });
  });
  test("comparisons check their operands too", () => {
    expect(run("log(x) < 1", { x: 0 }, "truth")).toEqual({ problems: [{ column: 1, message: "log() gives -Infinity" }] });
  });
  test("both sides of and and or are evaluated, so every problem shows", () => {
    expect(run("1 > 2 and log(x) < 1", { x: 0 }, "truth").problems).toEqual([{ column: 11, message: "log() gives -Infinity" }]);
    expect(run("1 < 2 or log(x) < 1", { x: 0 }, "truth").problems).toEqual([{ column: 10, message: "log() gives -Infinity" }]);
    expect(run("1 / x > 0 or log(x) < 1", { x: 0 }, "truth").problems).toEqual([
      { column: 3, message: '"/" gives Infinity' },
      { column: 14, message: "log() gives -Infinity" },
    ]);
  });
  test("a name without a value gives no value and no new problem", () => {
    expect(run("1 + log(a)", { a: undefined })).toEqual({ problems: [] });
    expect(run("a < 1 or 1 / b > 0", { a: undefined, b: 0 }, "truth").problems).toEqual([{ column: 12, message: '"/" gives Infinity' }]);
  });
  test("values", () => {
    expect(run("-cost", { cost: 2.5 })).toEqual({ value: -2.5, problems: [] });
    expect(run("score >= 780", { score: 780 }, "truth")).toEqual({ value: true, problems: [] });
    expect(run("not score >= 780", { score: 780 }, "truth")).toEqual({ value: false, problems: [] });
  });
});
