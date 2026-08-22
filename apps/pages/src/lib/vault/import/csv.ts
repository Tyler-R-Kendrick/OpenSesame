/**
 * RFC 4180 CSV reader.
 *
 * Password managers export real-world CSV: notes with embedded newlines and
 * commas, passwords containing quotes, CRLF from Windows exporters, and a BOM
 * from anything that has been through Excel. A naive `split(",")` corrupts
 * exactly the rows a user cares most about, so this is a character scanner.
 */

export type CsvRow = Record<string, string>;

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

/** Split CSV text into raw cells. Header handling is the caller's business. */
export function parseCsvCells(input: string): string[][] {
  // A BOM would otherwise become part of the first header name, so every
  // lookup against that column would silently miss.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    // A trailing newline should not manufacture a row of one empty cell.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);

    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
      continue;
    }
    if (char === ",") {
      endCell();
      continue;
    }
    if (char === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRow();
      continue;
    }
    if (char === "\n") {
      endRow();
      continue;
    }
    cell += char;
    cellStarted = true;
  }

  if (quoted) {
    throw new CsvParseError(
      "The file ends inside a quoted value, so it is truncated or not CSV.",
    );
  }
  if (cell !== "" || row.length > 0) endRow();

  return rows;
}

/**
 * Parse into objects keyed by header. Header names are lowercased and trimmed
 * so callers can match one spelling; exporters disagree on case.
 */
export function parseCsv(input: string) {
  const cells = parseCsvCells(input);
  const headerCells = cells[0];
  if (!headerCells || headerCells.length === 0) {
    throw new CsvParseError("That file has no header row.");
  }

  const headers = headerCells.map((name) => name.trim().toLowerCase());
  const rows: CsvRow[] = [];

  for (const line of cells.slice(1)) {
    // A row of nothing but empty cells is padding, not a record.
    if (line.every((value) => value.trim() === "")) continue;
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      if (header === "") return;
      row[header] = line[index] ?? "";
    });
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Read only the header row, respecting quotes.
 *
 * Detection needs the column names and nothing else. Slicing off the first
 * n bytes instead would eventually cut through the middle of a quoted note in
 * a large export and make a perfectly good file undetectable.
 */
export function readHeaderRow(input: string): string[] | null {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let end = text.length;
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      end = i;
      break;
    }
  }

  // An unterminated quote in the header itself means this is not CSV.
  if (quoted) return null;

  try {
    const cells = parseCsvCells(text.slice(0, end));
    const first = cells[0];
    return first ? first.map((cell) => cell.trim().toLowerCase()) : null;
  } catch {
    return null;
  }
}

/** First non-empty value among several possible column spellings. */
export function pick(row: CsvRow, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return "";
}

/** True when every required column is present, whatever the column order. */
export function hasHeaders(headers: string[], required: string[]): boolean {
  const set = new Set(headers);
  return required.every((name) => set.has(name));
}
