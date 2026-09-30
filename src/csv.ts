// A small RFC 4180 CSV parser that keeps the physical line of every record,
// so problems can be reported as file:line.

export interface CsvRecord {
  /** The physical line the record starts on, from 1. */
  line: number;
  fields: string[];
}

/** Thrown for malformed CSV, with the line of the problem. */
export class CsvError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
    this.name = "CsvError";
  }
}

/**
 * Parses CSV text into records. Fields may be quoted with `"`, a quote inside
 * a quoted field is written `""`, and quoted fields may span lines. Lines end
 * in LF or CRLF. Blank lines are skipped.
 */
export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    const start = line;
    const fields: string[] = [];
    let field = "";
    let atFieldStart = true;
    let quoted = false;
    let endOfRecord = false;

    while (i < n && !endOfRecord) {
      const c = text[i]!;
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            quoted = false;
            i++;
            const next = text[i];
            if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") {
              throw new CsvError(line, "unexpected character after a closing quote");
            }
          }
        } else {
          if (c === "\n") line++;
          field += c;
          i++;
        }
        continue;
      }
      if (c === '"' && atFieldStart) {
        quoted = true;
        atFieldStart = false;
        i++;
      } else if (c === '"') {
        throw new CsvError(line, "quote inside an unquoted field");
      } else if (c === ",") {
        fields.push(field);
        field = "";
        atFieldStart = true;
        i++;
      } else if (c === "\r" || c === "\n") {
        i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
        line++;
        endOfRecord = true;
      } else {
        field += c;
        atFieldStart = false;
        i++;
      }
    }
    if (quoted) throw new CsvError(start, "unterminated quoted field");
    fields.push(field);
    if (fields.length === 1 && fields[0] === "") continue;
    records.push({ line: start, fields });
  }
  return records;
}
