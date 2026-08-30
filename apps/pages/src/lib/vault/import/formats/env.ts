/**
 * dotenv / .env file import — the primary path for sealing Host and agent
 * material into the vault as secrets.
 *
 * Supports the common dotenv subset: `KEY=value`, optional `export`, single-
 * and double-quoted values, `#` comments, and blank lines. Multiline values
 * inside quotes are kept as one secret.
 */

import {
  type DetectInput,
  type DraftSecret,
  type ParseResult,
  type TextImportAdapter,
  draftSecret,
} from "../types.js";

const KEY_VALUE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u;

function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inDouble) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "#" && !inSingle && !inDouble) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const q = trimmed[0];
    if ((q === '"' || q === "'") && trimmed.endsWith(q)) {
      const inner = trimmed.slice(1, -1);
      if (q === '"') {
        return inner
          .replace(/\\n/gu, "\n")
          .replace(/\\r/gu, "\r")
          .replace(/\\t/gu, "\t")
          .replace(/\\"/gu, '"')
          .replace(/\\\\/gu, "\\");
      }
      return inner.replace(/\\'/gu, "'");
    }
  }
  return stripInlineComment(trimmed);
}

/** Parse dotenv text into KEY → value pairs, preserving first-seen order. */
export function parseDotenv(
  text: string,
): Array<{ key: string; value: string }> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/u);
  const out: Array<{ key: string; value: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i += 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = KEY_VALUE.exec(line.trimEnd());
    if (!match) continue;
    const key = match[1] ?? "";
    let rest = match[2] ?? "";
    const opener = rest.trimStart()[0];
    if (
      (opener === '"' || opener === "'") &&
      !isClosedQuote(rest.trimStart(), opener)
    ) {
      const chunks = [rest.trimStart()];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        i += 1;
        chunks.push(next);
        if (isClosedQuote(chunks.join("\n"), opener)) break;
      }
      rest = chunks.join("\n");
    }
    const value = unquote(rest);
    if (!key) continue;
    out.push({ key, value });
  }
  return out;
}

function isClosedQuote(text: string, quote: string): boolean {
  if (!text.startsWith(quote)) return false;
  let escaped = false;
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (ch === quote) return true;
  }
  return false;
}

function looksLikeDotenvName(fileName: string): boolean {
  const name = fileName.toLowerCase().split(/[/\\]/u).pop() ?? "";
  return (
    name === ".env" ||
    name === "env" ||
    name.endsWith(".env") ||
    /^\.env\./u.test(name) ||
    name.endsWith(".env.local") ||
    name.endsWith(".env.example") ||
    name.endsWith(".env.sample")
  );
}

function dotenvLineRatio(text: string): number {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) return 0;
  let hits = 0;
  for (const line of lines) {
    if (KEY_VALUE.test(line)) hits += 1;
  }
  return hits / lines.length;
}

export const envFile: TextImportAdapter = {
  id: "env-file",
  label: ".env file",
  shortName: ".env",
  hint: "A dotenv file (`KEY=value` lines). Each key becomes a secret.",
  accepts: "text",
  detect(input: DetectInput): boolean {
    if (input.json !== null) return false;
    if (input.headers && input.headers.length >= 2) return false;
    if (looksLikeDotenvName(input.fileName)) {
      return (
        dotenvLineRatio(input.text) >= 0.4 || parseDotenv(input.text).length > 0
      );
    }
    const ratio = dotenvLineRatio(input.text);
    return ratio >= 0.7 && parseDotenv(input.text).length >= 1;
  },
  parse(input: DetectInput): ParseResult {
    const pairs = parseDotenv(input.text);
    const items: DraftSecret[] = [];
    const skipped: ParseResult["skipped"] = [];
    const seen = new Set<string>();
    for (const { key, value } of pairs) {
      if (seen.has(key)) {
        skipped.push({
          name: key,
          reason: "Duplicate key later in the file — first value was kept.",
        });
        continue;
      }
      seen.add(key);
      if (value === "") {
        skipped.push({ name: key, reason: "Empty value." });
        continue;
      }
      const item = draftSecret(key);
      item.value = value;
      item.folder = "Imported .env";
      items.push(item);
    }
    return {
      source: "env-file",
      items,
      skipped,
      warnings:
        items.length > 0
          ? [
              "Keys are stored as secrets. Set ceilings and grantees only if you will grant one to an agent.",
            ]
          : [],
    };
  },
};
