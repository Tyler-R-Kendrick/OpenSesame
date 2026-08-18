/**
 * Importing from another password manager.
 *
 * The whole pipeline runs in this tab. A file is read with the File API,
 * parsed in memory, previewed, and merged into the sealed body. Nothing is
 * uploaded, and no parsed value is ever written to plaintext storage.
 */

import { readHeaderRow } from "./csv.js";
import { bitwardenCsv, bitwardenJson } from "./formats/bitwarden.js";
import {
  appleCsv,
  chromiumCsv,
  firefoxCsv,
  genericCsv,
} from "./formats/browsers.js";
import { envFile } from "./formats/env.js";
import {
  dashlaneCsv,
  keepassCsv,
  keepassxcCsv,
  lastpassCsv,
  nordpassCsv,
} from "./formats/managers.js";
import { onepasswordCsv, onepasswordPux } from "./formats/onepassword.js";
import { protonpassJson } from "./formats/protonpass.js";
import type {
  DetectInput,
  DraftItem,
  ImportAdapter,
  ParseResult,
  SourceId,
} from "./types.js";
import { readZipText } from "./zip.js";

export * from "./types.js";
export { readZipText, ZipError } from "./zip.js";
export {
  CsvParseError,
  parseCsv,
  parseCsvCells,
  readHeaderRow,
} from "./csv.js";
export { parseDotenv } from "./formats/env.js";

/**
 * Order is the detection chain. `.env` is first — the primary import for
 * sealing Host/agent material. Specific password-manager formats follow;
 * `genericCsv` is last because it accepts almost any CSV.
 */
export const ADAPTERS: ImportAdapter[] = [
  envFile,
  bitwardenJson,
  protonpassJson,
  onepasswordPux,
  bitwardenCsv,
  onepasswordCsv,
  lastpassCsv,
  keepassxcCsv,
  keepassCsv,
  dashlaneCsv,
  nordpassCsv,
  firefoxCsv,
  appleCsv,
  chromiumCsv,
  genericCsv,
];

export function adapterFor(id: SourceId): ImportAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/**
 * A password export is text. Anything much larger than this is not one, and
 * parsing it would lock the tab up rather than fail usefully.
 */
const MAX_BYTES = 64 * 1024 * 1024;

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text.slice(0, 4096).split(/\r?\n/u)[0] ?? "";
  return firstLine.includes(",");
}

/** Read a picked file into the shape adapters inspect. */
export async function readImportFile(file: File): Promise<DetectInput> {
  if (file.size > MAX_BYTES) {
    throw new ImportError(
      "That file is larger than 64 MB, which no password export should be.",
    );
  }
  if (file.size === 0) throw new ImportError("That file is empty.");

  const name = file.name.toLowerCase();
  const isArchive = name.endsWith(".1pux") || name.endsWith(".zip");

  let text: string;
  if (isArchive) {
    const buffer = await file.arrayBuffer();
    text = await readZipText(buffer, (entry) => entry.endsWith("export.data"));
  } else {
    text = await file.text();
  }

  let json: unknown = null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON after all; the CSV path or a named adapter will say so.
    }
  }

  // Only the header row is read here. A file truncated further down still
  // gets detected, then fails during the full parse with a message that names
  // the real problem.
  const headers =
    json === null && looksLikeCsv(text) ? readHeaderRow(text) : null;

  return { fileName: file.name, text, headers, json };
}

export function detectFormat(input: DetectInput): ImportAdapter | null {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.detect(input)) return adapter;
    } catch {
      // A detector must never take the whole chain down with it.
    }
  }
  return null;
}

export function parseImport(
  input: DetectInput,
  forced?: SourceId,
): ParseResult {
  const adapter = forced ? adapterFor(forced) : detectFormat(input);
  if (!adapter) {
    throw new ImportError(
      "This does not look like a .env file or a password-manager export. If you know the format, name it and the file will be read again.",
    );
  }
  const result = adapter.parse(input);
  if (result.items.length === 0 && result.skipped.length === 0) {
    throw new ImportError(
      `That file parsed as ${adapter.label} but held no items.`,
    );
  }
  return result;
}

export type ImportSummary = {
  logins: number;
  cards: number;
  notes: number;
  secrets: number;
  withTotp: number;
  withoutPassword: number;
  folders: string[];
};

export function summarise(items: DraftItem[]): ImportSummary {
  const folders = new Set<string>();
  let logins = 0;
  let cards = 0;
  let notes = 0;
  let secrets = 0;
  let withTotp = 0;
  let withoutPassword = 0;

  for (const item of items) {
    if (item.folder) folders.add(item.folder);
    if (item.kind === "login") {
      logins += 1;
      if (item.totp) withTotp += 1;
      if (!item.password) withoutPassword += 1;
    } else if (item.kind === "card") cards += 1;
    else if (item.kind === "secret") secrets += 1;
    else notes += 1;
  }

  return {
    logins,
    cards,
    notes,
    secrets,
    withTotp,
    withoutPassword,
    folders: [...folders].sort((a, b) => a.localeCompare(b)),
  };
}

/** How an incoming draft compares to what is already in the vault. */
export function duplicateKey(item: {
  kind: string;
  name: string;
  username?: string;
}): string {
  const kind = item.kind;
  const name = item.name.trim().toLowerCase();
  const username = (item.username ?? "").trim().toLowerCase();
  return JSON.stringify([kind, name, username]);
}
