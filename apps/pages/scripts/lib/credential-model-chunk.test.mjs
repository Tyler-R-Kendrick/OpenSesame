import { describe, expect, it } from "vitest";
import { credentialModelChunk } from "./credential-model-chunk.mjs";

const modules = [
  "packages/vault-core/src/account.ts",
  "packages/vault-core/src/credential.ts",
  "packages/vault-core/src/credential-bind.ts",
  "packages/vault-core/src/credential-split.ts",
  "packages/os-domain/src/json.ts",
];

describe("static shared credential model chunk", () => {
  it("keeps exactly the dependency-closed model modules together", () => {
    for (const module of modules) {
      expect(credentialModelChunk(`/workspace/OpenSesame/${module}`)).toBe(
        "shared-credential-model",
      );
      expect(
        credentialModelChunk(
          `C:\\workspace\\OpenSesame\\${module.replaceAll("/", "\\")}`,
        ),
      ).toBe("shared-credential-model");
    }
  });

  it("does not assign virtual, decorated or unrelated modules", () => {
    for (const module of modules) {
      for (const suffix of ["?raw", "?worker", "#fragment"]) {
        expect(
          credentialModelChunk(`/workspace/${module}${suffix}`),
        ).toBeUndefined();
      }
      expect(credentialModelChunk(`\0/workspace/${module}`)).toBeUndefined();
      expect(
        credentialModelChunk(`virtual:/workspace/${module}`),
      ).toBeUndefined();
    }
    for (const module of [
      "packages/vault-core/src/credential-read.ts",
      "packages/vault-core/src/model.ts",
      "packages/vault-core/src/crypto.ts",
      "packages/vault-core/src/account.test.ts",
      "packages/vault-core/src/credential.ts.map",
      "packages/os-domain/src/json.tsx",
      "packages/app-core/src/lib/vault/store.ts",
      "packages/app-core/src/modules/support.local-ai/index.ts",
      "node_modules/vault-core/src/credential.ts",
      "packages/not-vault-core/src/credential.ts",
    ]) {
      expect(credentialModelChunk(`/workspace/${module}`)).toBeUndefined();
    }
  });
});
