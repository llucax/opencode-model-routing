import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCsv, CsvError } from "../src/csv.ts";
import { DataError, loadData, normalizeId, parseData, parseWindowLength } from "../src/data.ts";
import { edited, fixtureModels, fixtureText, tempDir, writeFiles } from "./helpers.ts";

function errors(text: string, use?: string[]): string[] {
  try { parseData(text, "models.csv", use); }
  catch (error) { if (error instanceof DataError) return error.messages; throw error; }
  throw new Error("expected DataError");
}

describe("CSV records", () => {
  test("BOM, CRLF, escaped quotes and a multiline quoted field retain physical lines", () => {
    expect(parseCsv('\ufeffa,b\r\n"two\r\nlines","a""b"\r\n\r\nc,d\r\n')).toEqual([
      { line: 1, fields: ["a", "b"] },
      { line: 2, fields: ["two\r\nlines", 'a"b'] },
      { line: 5, fields: ["c", "d"] },
    ]);
  });
  test("quoted CSV errors carry the physical line", () => {
    expect(() => parseCsv('a,b\n"x"y,z')).toThrow(CsvError);
    expect(errors('model,vendor,effort,score\n"X\nY,z,none,1')).toEqual([
      "models.csv:2: CSV syntax error: unterminated quoted field",
    ]);
    expect(errors('model,vendor,effort,score\nX,z,none,1"')).toEqual([
      "models.csv:2: CSV syntax error: quote inside an unquoted field",
    ]);
  });
});

describe("data", () => {
  test("loads invented models, used columns, rows and oldest date", () => {
    const data = loadData(fixtureModels, ["quality", "price"]);
    expect(data.columns).toEqual(["model", "vendor", "effort", "date", "quality", "price"]);
    expect(data.rows).toHaveLength(8);
    expect(data.rows[0]).toMatchObject({ model: "Acme Big", vendor: "acme", effort: "high", values: { quality: 60, price: 5 }, line: 2 });
    expect(data.snapshot).toBe("2000-01-01");
    expect(normalizeId(" ACME.Big ")).toBe("acme-big");
  });
  test("unused columns may contain prose when explicit use is given", () => {
    const text = 'model,vendor,effort,score,note\n"Acme, New",a,none,1,"a\r\nb"\r\nZed,z,low,2,anything\r\n';
    expect(parseData(text, "models.csv", ["score"]).rows.map((row) => row.line)).toEqual([2, 4]);
    expect(errors(text)).toEqual([
      'models.csv:2: note "a\\r\\nb" is not a finite number',
      'models.csv:4: note "anything" is not a finite number',
    ]);
  });
  test("header: required fields, duplicate, blank, unavailable and nonnumeric use", () => {
    expect(errors("model,model,effort,,cost\nA,A,none,,2", ["score", "model"])).toEqual([
      'models.csv:1: duplicate column "model"', "models.csv:1: empty column name in the header",
      'models.csv:1: missing column "vendor"', 'models.csv:1: missing column "score", which the configuration uses',
      'models.csv:1: column "model" is not numeric and can\'t be used',
    ]);
    expect(errors("")).toEqual(["models.csv: empty file, expected a header row"]);
  });
  test("wrong field count, missing identity and unknown effort", () => {
    expect(errors("model,vendor,effort,score\nA,z,high\n,z,none,1\nA,,none,1\nA,z,extreme,1")).toEqual([
      "models.csv:2: 3 fields, but the header has 4", "models.csv:3: empty model", "models.csv:4: empty vendor",
      'models.csv:5: unknown effort "extreme"; the known efforts are: none, minimal, low, medium, high, xhigh, max',
    ]);
  });
  test("duplicate normalized model and effort, and inconsistent vendor", () => {
    expect(errors("model,vendor,effort,score\nAcme.Big,a,low,1\nacme-big,b,low,2")).toEqual([
      'models.csv:3: model "acme-big" has vendor "b", but "a" on line 2',
      'models.csv:3: duplicate row for model "acme-big" at effort low, first on line 2',
    ]);
  });
  test("every used numeric value must be finite, but negatives and exponent notation work", () => {
    expect(parseData("model,vendor,effort,score\nA,a,none,-1.5e2", "models.csv").rows[0]?.values.score).toBe(-150);
    expect(errors("model,vendor,effort,score\nA,a,none,NaN\nB,b,none,1e999\nC,c,none,")).toEqual([
      'models.csv:2: score "NaN" is not a finite number',
      'models.csv:3: score "1e999" is not a finite number', "models.csv:4: empty score",
    ]);
  });
  test("date format, impossible dates, and no rows", () => {
    expect(errors("model,vendor,effort,date,score\nA,a,none,2000-13-30,1")).toEqual(['models.csv:2: date "2000-13-30" is not YYYY-MM-DD']);
    expect(errors("model,vendor,effort,date,score\nA,a,none,2000-02-30,1")).toEqual(['models.csv:2: date "2000-02-30" is not YYYY-MM-DD']);
    expect(errors("model,vendor,effort,score\n")).toEqual(["models.csv: no rows"]);
    expect(parseData("model,vendor,effort,date,score\nA,a,none,,1", "models.csv").snapshot).toBeUndefined();
  });
  test("missing file and syntax errors are labeled", () => {
    try { loadData("/nonexistent/models.csv", undefined, "data.csv"); throw new Error("expected DataError"); }
    catch (error) { expect((error as DataError).messages).toEqual(["data.csv: cannot read: no such file"]); }
    const file = join(writeFiles(tempDir(), { "bad.csv": 'model,vendor,effort,score\n"unfinished' }), "bad.csv");
    expect(() => loadData(file)).toThrow(DataError);
  });
  test("fixture remains synthetic", () => {
    expect(fixtureText).toContain("Acme Big,acme");
  });
  test("all row errors are returned with their own physical line", () => {
    const text = "model,vendor,effort,score,cost\nA,a,high,no,1\nA,a,high,1,bad\nB,b,low,2\n";
    expect(errors(text)).toEqual([
      'models.csv:2: score "no" is not a finite number',
      'models.csv:3: cost "bad" is not a finite number',
      'models.csv:3: duplicate row for model "A" at effort high, first on line 2',
      'models.csv:4: 4 fields, but the header has 5',
    ]);
  });
  test("numeric column after quoted multiline text reports the record's starting line", () => {
    const text = 'model,vendor,effort,score\n"Multi\nLine",a,none,NaN\n';
    expect(errors(text)).toEqual(['models.csv:2: score "NaN" is not a finite number']);
  });
  test("fixed header fields cannot be chosen as numeric columns", () => {
    for (const column of ["model", "vendor", "effort", "date"]) {
      expect(errors("model,vendor,effort,date,score\nA,a,none,2000-01-01,1", [column]))
        .toContain(`models.csv:1: column "${column}" is not numeric and can't be used`);
    }
  });
});

test("window lengths", () => {
  expect(parseWindowLength("5h")).toBe(18000);
  expect(parseWindowLength("7d")).toBe(604800);
  expect(parseWindowLength("Weekly")).toBe(604800);
  expect(parseWindowLength("daily")).toBe(86400);
  expect(parseWindowLength("MONTHLY")).toBe("monthly");
  for (const invalid of ["", "0h", "h", "5m", "fortnightly"]) expect(parseWindowLength(invalid)).toBeUndefined();
});
