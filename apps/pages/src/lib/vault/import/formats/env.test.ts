import { describe, expect, it } from "vitest";
import { readHeaderRow } from "../csv.js";
import {
  type DetectInput,
  type DraftSecret,
  detectFormat,
  parseImport,
  summarise,
} from "../index.js";
import { parseDotenv } from "./env.js";

function input(fileName: string, text: string): DetectInput {
  let json: unknown = null;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const headers =
    json === null && text.split("\n")[0]?.includes(",")
      ? readHeaderRow(text)
      : null;
  return { fileName, text, headers, json };
}

describe(".env import", () => {
  it("parses KEY=value, export, quotes, and comments", () => {
    const pairs = parseDotenv(`
# comment
FOO=bar
export BAZ="quoted value"
EMPTY=
QUOTED='single'
WITH_HASH=keep # trailing
MULTILINE="line1\\nline2"
`);
    expect(pairs).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "quoted value" },
      { key: "EMPTY", value: "" },
      { key: "QUOTED", value: "single" },
      { key: "WITH_HASH", value: "keep" },
      { key: "MULTILINE", value: "line1\nline2" },
    ]);
  });

  it("detects .env files ahead of password-manager formats", () => {
    const file = input(
      ".env",
      "OPENAI_API_KEY=sk-test\nDATABASE_URL=postgres://localhost/db\n",
    );
    expect(detectFormat(file)?.id).toBe("env-file");
    const result = parseImport(file);
    expect(result.source).toBe("env-file");
    expect(result.items).toHaveLength(2);
    const secret = result.items[0] as DraftSecret;
    expect(secret.kind).toBe("secret");
    expect(secret.name).toBe("OPENAI_API_KEY");
    expect(secret.value).toBe("sk-test");
    expect(summarise(result.items).secrets).toBe(2);
  });

  it("does not steal a CSV password export", () => {
    const csv = input(
      "passwords.csv",
      "url,username,password\nhttps://example.com,ada,hunter2\n",
    );
    expect(detectFormat(csv)?.id).not.toBe("env-file");
  });
});
