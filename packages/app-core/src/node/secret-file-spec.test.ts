/**
 * `spec/secret-files/*.schema.json` is the file format's definition for every
 * plane (ADR 0139, ADR 0182), generated from the schemas the TypeScript plane
 * reads with. A change to a schema that is not regenerated fails here:
 * `UPDATE_SECRET_FILE_SPEC=1 pnpm --filter @opensesame/app-core exec vitest run src/node/secret-file-spec.test.ts`,
 * then `pnpm exec biome format --write spec/secret-files`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ConfigDoc } from "../lib/secret-fs/config-docs.js";
import {
  FolderDoc,
  ManifestDoc,
  SecretDoc,
} from "../lib/secret-fs/secret-docs.js";

const specPath = (name: string) =>
  fileURLToPath(
    new URL(`../../../../spec/secret-files/${name}`, import.meta.url),
  );

const documents = {
  "secret-file.schema.json": SecretDoc,
  "config-file.schema.json": ConfigDoc,
  "folder-file.schema.json": FolderDoc,
  "vault-manifest.schema.json": ManifestDoc,
} as const;

describe("the secret file format's definition", () => {
  for (const [name, schema] of Object.entries(documents)) {
    it(`${name} is what the code reads with`, () => {
      const generated = Schema.toJsonSchemaDocument(schema);
      if (process.env.UPDATE_SECRET_FILE_SPEC === "1") {
        writeFileSync(
          specPath(name),
          `${JSON.stringify(generated, null, 2)}\n`,
        );
      }
      expect(JSON.parse(readFileSync(specPath(name), "utf8"))).toEqual(
        JSON.parse(JSON.stringify(generated)),
      );
    });
  }
});
