// The expression language of formulas and predicates: numbers, names,
// arithmetic, a few functions, comparisons and and/or/not. Parsed into a tree
// by hand and evaluated by walking it: never compiled to JavaScript, with no
// property access, objects or user functions.
//
// Grammar, lowest precedence first:
//
//   or      := and ("or" and)*
//   and     := not ("and" not)*
//   not     := "not" not | compare
//   compare := sum (("<" | "<=" | ">" | ">=" | "==" | "!=") sum)?
//   sum     := product (("+" | "-") product)*
//   product := unary (("*" | "/") unary)*
//   unary   := "-" unary | power
//   power   := atom ("^" unary)?
//   atom    := number | name | name "(" or ("," or)* ")" | "(" or ")"
//
// Comparisons don't chain, `^` is right-associative and binds tighter than a
// leading minus (`-2^2` is -4, `2^-2` is 0.25). Function arguments parse as
// any expression so that a comparison there gets a type error, which says
// more than a syntax error would.

/** What an expression gives: a number, or a truth value. */
export type ExprType = "number" | "truth";

export type CompareOp = "<" | "<=" | ">" | ">=" | "==" | "!=";
export type ArithOp = "+" | "-" | "*" | "/" | "^";

/** A node of the tree; `pos` is the 0-based offset of the token it starts at or is about. */
export type Node =
  | { kind: "number"; value: number; pos: number }
  | { kind: "name"; name: string; pos: number }
  | { kind: "call"; name: string; args: Node[]; pos: number }
  | { kind: "negate"; operand: Node; pos: number }
  | { kind: "not"; operand: Node; pos: number }
  | { kind: "arith"; op: ArithOp; left: Node; right: Node; pos: number }
  | { kind: "compare"; op: CompareOp; left: Node; right: Node; pos: number }
  | { kind: "logic"; op: "and" | "or"; left: Node; right: Node; pos: number };

/** A problem at a column (1-based) of the expression. */
export class ExprError extends Error {
  constructor(
    readonly column: number,
    message: string,
  ) {
    super(message);
    this.name = "ExprError";
  }
}

/** The functions and how many arguments each takes: an exact count, or at least `min`. */
const FUNCTIONS: Record<string, { args: number } | { min: number }> = {
  log: { args: 1 },
  log2: { args: 1 },
  log10: { args: 1 },
  sqrt: { args: 1 },
  abs: { args: 1 },
  min: { min: 2 },
  max: { min: 2 },
};

export const KEYWORDS = ["and", "or", "not"];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `text` can be a name in an expression: an identifier that isn't a keyword. */
export function isName(text: string): boolean {
  return NAME.test(text) && !KEYWORDS.includes(text);
}

type Token =
  | { kind: "number"; value: number; pos: number; text: string }
  | { kind: "name"; text: string; pos: number }
  | { kind: "op"; text: string; pos: number }
  | { kind: "end"; pos: number; text: "" };

const OPERATORS = ["<=", ">=", "==", "!=", "<", ">", "+", "-", "*", "/", "^", "(", ")", ","];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    const number = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new ExprError(i + 1, `number ${number[0]} is too large`);
      if (/^[A-Za-z_.]/.test(rest.slice(number[0].length))) {
        throw new ExprError(i + 1, `malformed number "${/^[\w.]+/.exec(rest)![0]}"`);
      }
      tokens.push({ kind: "number", value, pos: i, text: number[0] });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (name) {
      tokens.push({ kind: "name", text: name[0], pos: i });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (op === undefined) {
      const hint = rest.startsWith("=") ? '; use "==" to compare' : rest.startsWith("&") || rest.startsWith("|") || rest.startsWith("!") ? '; use "and", "or" and "not"' : "";
      throw new ExprError(i + 1, `unexpected character "${String.fromCodePoint(rest.codePointAt(0)!)}"${hint}`);
    }
    tokens.push({ kind: "op", text: op, pos: i });
    i += op.length;
  }
  tokens.push({ kind: "end", pos: text.length, text: "" });
  return tokens;
}

const COMPARE_OPS: readonly string[] = ["<", "<=", ">", ">=", "==", "!="];

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  private get token(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private isOp(text: string): boolean {
    return this.token.kind === "op" && this.token.text === text;
  }

  private isKeyword(text: string): boolean {
    return this.token.kind === "name" && this.token.text === text;
  }

  private unexpected(expected: string): never {
    const token = this.token;
    if (token.kind === "end") throw new ExprError(token.pos + 1, `unexpected end of the expression, expected ${expected}`);
    throw new ExprError(token.pos + 1, `unexpected "${token.text}", expected ${expected}`);
  }

  private atEnd(): boolean {
    return this.token.kind === "end";
  }

  parse(): Node {
    if (this.atEnd()) throw new ExprError(1, "empty expression");
    const node = this.or();
    if (!this.atEnd()) this.unexpected("an operator or the end");
    return node;
  }

  private or(): Node {
    let left = this.and();
    while (this.isKeyword("or")) {
      const pos = this.next().pos;
      left = { kind: "logic", op: "or", left, right: this.and(), pos };
    }
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.isKeyword("and")) {
      const pos = this.next().pos;
      left = { kind: "logic", op: "and", left, right: this.not(), pos };
    }
    return left;
  }

  private not(): Node {
    if (this.isKeyword("not")) {
      const pos = this.next().pos;
      return { kind: "not", operand: this.not(), pos };
    }
    return this.compare();
  }

  private compare(): Node {
    const left = this.sum();
    if (this.token.kind !== "op" || !COMPARE_OPS.includes(this.token.text)) return left;
    const token = this.next();
    const right = this.sum();
    if (this.token.kind === "op" && COMPARE_OPS.includes(this.token.text)) {
      throw new ExprError(this.token.pos + 1, 'comparisons can\'t be chained; join them with "and"');
    }
    return { kind: "compare", op: token.text as CompareOp, left, right, pos: token.pos };
  }

  private sum(): Node {
    let left = this.product();
    while (this.isOp("+") || this.isOp("-")) {
      const token = this.next();
      left = { kind: "arith", op: token.text as ArithOp, left, right: this.product(), pos: token.pos };
    }
    return left;
  }

  private product(): Node {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const token = this.next();
      left = { kind: "arith", op: token.text as ArithOp, left, right: this.unary(), pos: token.pos };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp("-")) {
      const pos = this.next().pos;
      return { kind: "negate", operand: this.unary(), pos };
    }
    return this.power();
  }

  private power(): Node {
    const base = this.atom();
    if (!this.isOp("^")) return base;
    const pos = this.next().pos;
    return { kind: "arith", op: "^", left: base, right: this.unary(), pos };
  }

  private atom(): Node {
    const token = this.token;
    if (token.kind === "number") {
      this.next();
      return { kind: "number", value: token.value, pos: token.pos };
    }
    if (token.kind === "name") {
      if (KEYWORDS.includes(token.text)) this.unexpected("a number, a name or \"(\"");
      this.next();
      if (!this.isOp("(")) return { kind: "name", name: token.text, pos: token.pos };
      this.next();
      const args = [this.or()];
      while (this.isOp(",")) {
        this.next();
        args.push(this.or());
      }
      if (!this.isOp(")")) this.unexpected('"," or ")"');
      this.next();
      return { kind: "call", name: token.text, args, pos: token.pos };
    }
    if (this.isOp("(")) {
      this.next();
      const inner = this.or();
      if (!this.isOp(")")) this.unexpected('")"');
      this.next();
      return inner;
    }
    return this.unexpected('a number, a name or "("');
  }
}

/** Parses an expression into its tree, or throws an `ExprError` with the column of the problem. */
export function parse(text: string): Node {
  return new Parser(tokenize(text)).parse();
}

/** What a node is, in words, for type errors. */
function describe(node: Node): string {
  if (node.kind === "compare") return "a comparison";
  if (node.kind === "logic" || node.kind === "not") return "a combination of comparisons";
  return "a number";
}

/** Checks the types of the tree and returns what it gives. */
export function typeOf(node: Node): ExprType {
  const expect = (operand: Node, type: ExprType, what: string): void => {
    const actual = typeOf(operand);
    if (actual === type) return;
    const column = operand.pos + 1;
    if (type === "number") throw new ExprError(column, `${what} takes numbers, not ${describe(operand)}`);
    throw new ExprError(column, `${what} takes comparisons or combinations of them, not a number`);
  };
  switch (node.kind) {
    case "number":
    case "name":
      return "number";
    case "call": {
      const spec = FUNCTIONS[node.name];
      if (spec === undefined) throw new ExprError(node.pos + 1, `unknown function "${node.name}"; the functions are ${Object.keys(FUNCTIONS).join(", ")}`);
      if ("args" in spec && node.args.length !== spec.args) {
        throw new ExprError(node.pos + 1, `${node.name}() takes ${spec.args} argument${spec.args === 1 ? "" : "s"}, got ${node.args.length}`);
      }
      if ("min" in spec && node.args.length < spec.min) {
        throw new ExprError(node.pos + 1, `${node.name}() takes at least ${spec.min} arguments, got ${node.args.length}`);
      }
      for (const arg of node.args) expect(arg, "number", `${node.name}()`);
      return "number";
    }
    case "negate":
      expect(node.operand, "number", '"-"');
      return "number";
    case "arith":
      expect(node.left, "number", `"${node.op}"`);
      expect(node.right, "number", `"${node.op}"`);
      return "number";
    case "compare":
      expect(node.left, "number", `"${node.op}"`);
      expect(node.right, "number", `"${node.op}"`);
      return "truth";
    case "not":
      expect(node.operand, "truth", '"not"');
      return "truth";
    case "logic":
      expect(node.left, "truth", `"${node.op}"`);
      expect(node.right, "truth", `"${node.op}"`);
      return "truth";
  }
}

/** Every name the tree refers to, with its column, in order of appearance. */
export function names(node: Node): { name: string; column: number }[] {
  switch (node.kind) {
    case "number":
      return [];
    case "name":
      return [{ name: node.name, column: node.pos + 1 }];
    case "call":
      return node.args.flatMap(names);
    case "negate":
    case "not":
      return names(node.operand);
    case "arith":
    case "compare":
    case "logic":
      return [...names(node.left), ...names(node.right)];
  }
}

/** A parsed and type-checked expression. */
export interface Expr {
  /** The expression as written. */
  text: string;
  node: Node;
  type: ExprType;
  /** The names it refers to, with their columns. */
  names: { name: string; column: number }[];
}

/**
 * Parses an expression and checks that it gives `type`: a formula must give
 * a number, a predicate a truth value.
 */
export function compile(text: string, type: ExprType): Expr {
  const node = parse(text);
  const actual = typeOf(node);
  // The column of the root: the outermost operator, or where a lone term starts.
  if (type === "number" && actual !== "number") throw new ExprError(node.pos + 1, `a formula must give a number, this is ${describe(node)}`);
  if (type === "truth" && actual !== "truth") {
    throw new ExprError(node.pos + 1, "a predicate must be a comparison or a combination of them, this is a number");
  }
  return { text, node, type, names: names(node) };
}

/** A non-finite result, at a column of the expression. */
export interface EvalProblem {
  column: number;
  message: string;
}

/**
 * Evaluates an expression. `lookup` gives each name's value, or undefined
 * when it has none because of a problem already reported elsewhere. A
 * non-finite number at any node is a problem, reported where it first
 * appears; the nodes above it give no value and report nothing more. Both
 * sides of `and` and `or` are evaluated, so every problem shows.
 */
export function evaluate(
  expr: Expr,
  lookup: (name: string) => number | undefined,
): { value?: number | boolean; problems: EvalProblem[] } {
  const problems: EvalProblem[] = [];
  const finite = (value: number, node: Node, what: string): number | undefined => {
    if (Number.isFinite(value)) return value;
    problems.push({ column: node.pos + 1, message: `${what} gives ${value}` });
    return undefined;
  };
  const number = (node: Node): number | undefined => walk(node) as number | undefined;
  const truth = (node: Node): boolean | undefined => walk(node) as boolean | undefined;
  const walk = (node: Node): number | boolean | undefined => {
    switch (node.kind) {
      case "number":
        return node.value;
      case "name":
        return lookup(node.name);
      case "call": {
        const args = node.args.map(number);
        if (args.some((arg) => arg === undefined)) return undefined;
        const values = args as number[];
        return finite(callFunction(node.name, values), node, `${node.name}()`);
      }
      case "negate": {
        const value = number(node.operand);
        return value === undefined ? undefined : -value;
      }
      case "arith": {
        const left = number(node.left);
        const right = number(node.right);
        if (left === undefined || right === undefined) return undefined;
        return finite(arith(node.op, left, right), node, `"${node.op}"`);
      }
      case "compare": {
        const left = number(node.left);
        const right = number(node.right);
        if (left === undefined || right === undefined) return undefined;
        return compare(node.op, left, right);
      }
      case "not": {
        const value = truth(node.operand);
        return value === undefined ? undefined : !value;
      }
      case "logic": {
        const left = truth(node.left);
        const right = truth(node.right);
        if (left === undefined || right === undefined) return undefined;
        return node.op === "and" ? left && right : left || right;
      }
    }
  };
  const value = walk(expr.node);
  return value === undefined ? { problems } : { value, problems };
}

function callFunction(name: string, args: number[]): number {
  switch (name) {
    case "log":
      return Math.log(args[0]!);
    case "log2":
      return Math.log2(args[0]!);
    case "log10":
      return Math.log10(args[0]!);
    case "sqrt":
      return Math.sqrt(args[0]!);
    case "abs":
      return Math.abs(args[0]!);
    case "min":
      return Math.min(...args);
    case "max":
      return Math.max(...args);
  }
  throw new Error(`unknown function ${name}`);
}

function arith(op: ArithOp, left: number, right: number): number {
  switch (op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "^":
      return left ** right;
  }
}

function compare(op: CompareOp, left: number, right: number): boolean {
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
  }
}
