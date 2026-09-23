import { describe, expect, it } from "vitest";
import {
  canonicalSectorIdentifier,
  pairwiseSectorKey,
  sectorIdentifierSpellings,
} from "../pairwise/sector.js";
import {
  MemoryPairwiseSubjectStore,
  createPairwiseIdentifierCallback,
} from "../pairwise/store.js";

describe("pairwise subjects", () => {
  it("returns a stable subject for the same principal + sector", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const pairwise = createPairwiseIdentifierCallback(store);

    const a = await pairwise({}, "principal-1", {
      clientId: "alpha",
      sectorIdentifier: "sector-a",
    });
    const b = await pairwise({}, "principal-1", {
      clientId: "alpha",
      sectorIdentifier: "sector-a",
    });

    expect(a).toBe(b);
    expect(a).not.toBe("principal-1");
  });

  it("refuses a shared default sector when clientId and sector are missing", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const pairwise = createPairwiseIdentifierCallback(store);
    await expect(pairwise({}, "principal-1", {})).rejects.toThrow(
      /sectorIdentifier or clientId/,
    );
  });

  it("returns different subjects across sectors", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const pairwise = createPairwiseIdentifierCallback(store);

    const sectorA = await pairwise({}, "principal-1", {
      clientId: "alpha",
      sectorIdentifier: "sector-a",
    });
    const sectorB = await pairwise({}, "principal-1", {
      clientId: "beta",
      sectorIdentifier: "sector-b",
    });

    expect(sectorA).not.toBe(sectorB);
  });

  it("keys on the registered sector, not the shared redirect host", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const records = new Map([
      ["alice", { sectorIdentifier: "https://alice.example" }],
      ["bob", { sectorIdentifier: "https://bob.example" }],
    ]);
    const pairwise = createPairwiseIdentifierCallback(store, {
      findById: async (id) => records.get(id),
    });
    // oidc-provider hands both the host of redirect_uris[0].
    const alice = await pairwise({}, "principal-1", {
      clientId: "alice",
      sectorIdentifier: "localhost:3000",
    });
    const bob = await pairwise({}, "principal-1", {
      clientId: "bob",
      sectorIdentifier: "localhost:3000",
    });
    expect(alice).not.toBe(bob);
    expect((await store.find("principal-1", "alice.example"))?.subject).toBe(
      alice,
    );
    expect(await store.find("principal-1", "localhost:3000")).toBeUndefined();
  });

  it("keeps the existing sub when the registered sector is the redirect host", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const before = await createPairwiseIdentifierCallback(store)(
      {},
      "principal-1",
      { clientId: "rp", sectorIdentifier: "rp.example" },
    );
    const after = await createPairwiseIdentifierCallback(store, {
      findById: async () => ({ sectorIdentifier: "https://rp.example" }),
    })({}, "principal-1", { clientId: "rp", sectorIdentifier: "rp.example" });
    expect(after).toBe(before);
  });

  it("falls back to oidc-provider's sector for a client the store does not hold", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const pairwise = createPairwiseIdentifierCallback(store, {
      findById: async () => undefined,
    });
    await pairwise({}, "principal-1", {
      clientId: "static",
      sectorIdentifier: "static.example",
    });
    expect(await store.find("principal-1", "static.example")).toBeDefined();
  });

  it("keys on the stored sector key when the store carries one", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const pairwise = createPairwiseIdentifierCallback(store, {
      findById: async () => ({
        sectorIdentifier: "https://RP.example:443/",
        sectorKey: "rp.example",
      }),
    });
    const sub = await pairwise({}, "principal-1", { clientId: "rp" });
    expect((await store.find("principal-1", "rp.example"))?.subject).toBe(sub);
  });

  it("issues no subject to a client blocked from its sector key", async () => {
    const store = new MemoryPairwiseSubjectStore();
    const holder = await createPairwiseIdentifierCallback(store, {
      findById: async () => ({ sectorIdentifier: "https://rp.example" }),
    })({}, "principal-1", { clientId: "holder" });
    for (const sectorKeyBlocked of [
      "cross_owner_collision",
      "unparsed_legacy_spelling",
    ]) {
      const blocked = createPairwiseIdentifierCallback(store, {
        findById: async () => ({
          sectorIdentifier: "https://RP.example:443/",
          sectorKey: "rp.example",
          sectorKeyBlocked,
        }),
      });
      await expect(
        blocked({}, "principal-1", {
          clientId: "late",
          sectorIdentifier: "rp.example",
        }),
      ).rejects.toMatchObject({ error: "invalid_client" });
    }
    expect((await store.find("principal-1", "rp.example"))?.subject).toBe(
      holder,
    );
  });
});

describe("pairwise sector keys", () => {
  it("keys an origin-form sector on its host and a path sector on host + path", () => {
    expect(pairwiseSectorKey("https://RP.example:443/")).toBe("rp.example");
    expect(pairwiseSectorKey("https://rp.example:8443")).toBe(
      "rp.example:8443",
    );
    expect(pairwiseSectorKey("https://shared.example/a")).toBe(
      "shared.example/a",
    );
    expect(pairwiseSectorKey("https://shared.example/b")).not.toBe(
      pairwiseSectorKey("https://shared.example/a"),
    );
    // Non-URL sectors (origin clients, static hosts) are used verbatim.
    expect(pairwiseSectorKey("sector_abc")).toBe("sector_abc");
    expect(pairwiseSectorKey("localhost:3000")).toBe("localhost:3000");
  });

  it("canonicalizes spellings that share a key", () => {
    expect(canonicalSectorIdentifier("https://RP.example:443/")).toBe(
      "https://rp.example",
    );
    expect(canonicalSectorIdentifier("https://rp.example/p")).toBe(
      "https://rp.example/p",
    );
    expect(sectorIdentifierSpellings("https://RP.example")).toEqual([
      "https://rp.example",
      "https://RP.example",
      "https://rp.example/",
    ]);
  });
});
