/**
 * Test-only access to the checked-in upstream fixtures.
 *
 * Under `test/` deliberately: it reads fixture files with `node:fs`, and
 * `scripts/mtls-static-imports.mjs` (AT-STATIC-IMPORTS) treats everything
 * else under `src/` as a shipped source that may not import a native
 * module. Nothing the browser loads imports this file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonTree } from "../json-codec.js";
import type { SopsNode } from "../model.js";
import { goFloatText } from "../scalars.js";
import { parseYamlDocuments } from "../yaml-parse.js";

export const UPSTREAM_DIR = join(__dirname, "..", "fixtures", "upstream");

export type FixtureCase = {
  name: string;
  format: "yaml" | "json";
  plain: string;
  args: string[];
  config: string | null;
  identities: number[];
  encryptedSha256: string;
  decryptedSha256: string;
  decryptedJsonAvailable: boolean;
};

export type FixtureManifest = {
  sopsVersion: string;
  sourceCommit: string;
  oracle: { name: string; sha256: string };
  cases: FixtureCase[];
};

export function readManifest(): FixtureManifest {
  return JSON.parse(readFileSync(join(UPSTREAM_DIR, "manifest.json"), "utf8"));
}

export function readIdentities(): { identity: string; recipient: string }[] {
  const parsed: { identities: { identity: string; recipient: string }[] } =
    JSON.parse(readFileSync(join(UPSTREAM_DIR, "identities.json"), "utf8"));
  return parsed.identities;
}

export function readFixture(name: string): string {
  return readFileSync(join(UPSTREAM_DIR, name), "utf8");
}

/**
 * A comparable shape that drops what upstream's own emitter normalizes
 * when it writes plaintext, so a fixture's expected file can be compared
 * with this engine's output (SB-027 characterization):
 *
 *  - an inline comment is emitted as a head comment;
 *  - an integral float prints without a fraction, so `1.0` reads back as
 *    the integer 1 — both sides collapse to one numeric token here;
 *  - float negative zero prints as `-0`, which upstream's own loader then
 *    reads as the integer 0. This engine writes `-0.0` instead, which
 *    upstream loads as float negative zero (verified against the pinned
 *    loader), preserving the type and the `-0` MAC bytes upstream itself
 *    would drop. The sign of zero is normalized away here for that reason.
 *
 * Everything else — order, keys, scalar kinds and bytes, comment text —
 * must agree exactly.
 */
export type Loose =
  | { map: Loose[] }
  | { seq: Loose[] }
  | { comment: string }
  | { key: string; value: Loose }
  | { scalar: string }
  | { null: true };

/** Upstream renders float -0 as `-0` and int -0 as `0`; the value is one. */
function numeric(text: string): string {
  return text === "-0" ? "0" : text;
}

export function loose(node: SopsNode): Loose {
  switch (node.kind) {
    case "null":
      return { null: true };
    case "scalar": {
      const scalar = node.scalar;
      if (scalar.kind === "float")
        return { scalar: `num:${numeric(goFloatText(scalar.value))}` };
      if (scalar.kind === "int")
        return { scalar: `num:${numeric(scalar.value)}` };
      if (scalar.kind === "bool") return { scalar: `bool:${scalar.value}` };
      if (scalar.kind === "time") return { scalar: `time:${scalar.value}` };
      return { scalar: `str:${scalar.value}` };
    }
    case "seq":
      return {
        seq: node.items.map((item) =>
          item.kind === "comment" ? { comment: item.value } : loose(item),
        ),
      };
    case "map":
      return {
        map: node.items.map((item) =>
          item.kind === "comment"
            ? { comment: item.value }
            : { key: item.key, value: loose(item.value) },
        ),
      };
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

export function looseDocuments(text: string, format: "yaml" | "json"): Loose[] {
  return (
    format === "json" ? [parseJsonTree(text)] : parseYamlDocuments(text)
  ).map(loose);
}
