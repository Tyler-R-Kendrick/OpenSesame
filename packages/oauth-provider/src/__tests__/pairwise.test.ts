import { describe, expect, it } from "vitest";
import {
  createPairwiseIdentifierCallback,
  MemoryPairwiseSubjectStore,
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
    await expect(pairwise({}, "principal-1", {})).rejects.toThrow(/sectorIdentifier or clientId/);
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
});
