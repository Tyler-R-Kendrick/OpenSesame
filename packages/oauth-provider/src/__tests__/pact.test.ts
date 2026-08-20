import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { createOpenSesameProvider } from "../create-provider.js";
import { MemoryPairwiseSubjectStore } from "../pairwise/store.js";
import { overlapCast } from "@opensesame/os-domain";

const here = dirname(fileURLToPath(import.meta.url));
const jwks = { keys: [{ kty: "RSA" }] };

describe("PACT — oauth pairwise / adapter fail-closed", () => {
  it("production refuses memory adapter and memory pairwise store", () => {
    assertSourceOrder(
      readFileSync(join(here, "../create-provider.ts"), "utf8"),
      [
        "env.isProduction && !options.adapter",
        "env.isProduction && !options.pairwiseStore",
        "MemoryPairwiseSubjectStore",
      ],
    );
    expect(() =>
      createOpenSesameProvider({
        issuer: "https://id.example.test",
        env: { isProduction: true },
        processEnv: {},
        jwks,
      }),
    ).toThrow(/persistent adapter/);
    expect(() =>
      createOpenSesameProvider({
        issuer: "https://id.example.test",
        env: { isProduction: true },
        processEnv: {},
        jwks,
        adapter: overlapCast(() => {
          throw new Error("adapter unused");
        }),
      }),
    ).toThrow(/pairwise subject store/);
  });

  it("memory pairwise subjects stay stable for one process", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const a = await store.getOrCreate("p1", "sector");
    const b = await store.getOrCreate("p1", "sector");
    expect(a.subject).toBe(b.subject);
  });

  it("chaos: concurrent getOrCreate keeps a single subject", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const minted = await Promise.all(
      Array.from({ length: 32 }, () => store.getOrCreate("p1", "sector")),
    );
    expect(new Set(minted.map((row) => row.subject)).size).toBe(1);
  });
});
