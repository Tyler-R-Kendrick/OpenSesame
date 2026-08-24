import type { BoundaryValue } from "@opensesame/os-domain";

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
import { fidoCxf } from "./formats/cxf.js";
import { envFile } from "./formats/env.js";
import { keepassKdbx } from "./formats/kdbx.js";
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
  ParseInput,
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
  fidoCxf,
  protonpassJson,
  onepasswordPux,
  keepassKdbx,
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

/**
 * Extensions whose contents are a single encrypted blob rather than text.
 * The magic-byte check below catches the same file under any other name, so
 * this list only has to cover what people actually pick.
 */
const BINARY_EXTENSIONS = [".kdbx", ".kdb"];

/**
 * A NUL in the first kilobyte means the file was never text, whatever the
 * extension claimed. UTF-8 decoding has already mangled it by this point, so
 * the bytes are re-read rather than salvaged.
 */
function looksBinary(text: string): boolean {
  return text.slice(0, 1024).includes("\u0000");
}

const EMPTY_TEXT: Omit<DetectInput, "fileName" | "bytes"> = {
  text: "",
  headers: null,
  json: null,
};

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

  if (BINARY_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    const buffer = await file.arrayBuffer();
    return {
      fileName: file.name,
      ...EMPTY_TEXT,
      bytes: new Uint8Array(buffer),
    };
  }

  let text: string;
  if (isArchive) {
    const buffer = await file.arrayBuffer();
    text = await readZipText(buffer, (entry) => entry.endsWith("export.data"));
  } else {
    text = await file.text();
  }

  // A database saved under a name we did not anticipate. Reading it twice
  // costs one extra pass over a file the user is importing anyway, and is far
  // better than telling them their vault "is not a password export".
  if (!isArchive && looksBinary(text)) {
    const buffer = await file.arrayBuffer();
    return {
      fileName: file.name,
      ...EMPTY_TEXT,
      bytes: new Uint8Array(buffer),
    };
  }

  let json: BoundaryValue = null;
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

  return { fileName: file.name, text, headers, json, bytes: null };
}

/**
 * Binary input only ever reaches `"binary"` adapters, and text input never
 * does. Without this a CSV detector would be handed an empty `text` for every
 * database, and `genericCsv` — which accepts almost anything — sits at the end
 * of the chain waiting to claim it.
 */
function handles(adapter: ImportAdapter, input: DetectInput): boolean {
  return input.bytes !== null
    ? adapter.accepts === "binary"
    : adapter.accepts !== "binary";
}

export function detectFormat(input: DetectInput): ImportAdapter | null {
  for (const adapter of ADAPTERS) {
    if (!handles(adapter, input)) continue;
    try {
      if (adapter.detect(input)) return adapter;
    } catch {
      // A detector must never take the whole chain down with it.
    }
  }
  return null;
}

function adapterOrThrow(input: DetectInput, forced?: SourceId): ImportAdapter {
  const adapter = forced ? adapterFor(forced) : detectFormat(input);
  if (!adapter) {
    throw new ImportError(
      "This does not look like a .env file or a password-manager export. If you know the format, name it and the file will be read again.",
    );
  }
  return adapter;
}

/**
 * A result with nothing in it is a failed read wearing a success's clothes —
 * except when the adapter is asking for a password, where empty is the whole
 * point.
 */
function checkNotEmpty(result: ParseResult, adapter: ImportAdapter): void {
  if (result.needsPassword) return;
  if (result.items.length === 0 && result.skipped.length === 0) {
    throw new ImportError(
      `That file parsed as ${adapter.label} but held no items.`,
    );
  }
}

/**
 * Synchronous read, for the text and CSV formats that have always been one.
 * A format whose parse is asynchronous — every encrypted binary one — is
 * refused here by name rather than returning a promise dressed as a result;
 * use `parseImportAsync`, which handles both.
 */
export function parseImport(input: ParseInput, forced?: SourceId): ParseResult {
  const adapter = adapterOrThrow(input, forced);
  const result = adapter.parse(input);
  if (result instanceof Promise) {
    // Nothing must observe a floating rejection from a promise we discard.
    void result.catch(() => {});
    throw new ImportError(
      `${adapter.label} has to be decrypted before it can be read; use the asynchronous import path.`,
    );
  }
  checkNotEmpty(result, adapter);
  return result;
}

/**
 * The path the import screen uses. Identical to `parseImport` for text
 * formats, and the only way to read a binary one.
 */
export async function parseImportAsync(
  input: ParseInput,
  forced?: SourceId,
): Promise<ParseResult> {
  const adapter = adapterOrThrow(input, forced);
  const result = await adapter.parse(input);
  checkNotEmpty(result, adapter);
  return result;
}

export type ImportSummary = {
  logins: number;
  passkeys: number;
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
  let passkeys = 0;
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
    } else if (item.kind === "passkey") passkeys += 1;
    else if (item.kind === "card") cards += 1;
    else if (item.kind === "secret") secrets += 1;
    else notes += 1;
  }

  return {
    logins,
    passkeys,
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
