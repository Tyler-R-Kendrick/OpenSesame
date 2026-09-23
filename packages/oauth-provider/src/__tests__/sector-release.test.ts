import { describe, expect, it } from "vitest";
import {
  MemoryClientRecordStore,
  SectorKeyClaimedError,
} from "../clients/store.js";
import { pairwiseSubjectSector } from "../pairwise/sector.js";
import {
  MemoryPairwiseSubjectStore,
  createPairwiseIdentifierCallback,
} from "../pairwise/store.js";
import type { OAuthClientRecord } from "../types.js";

function registration(
  id: string,
  ownerPrincipalId: string,
  sectorIdentifier: string,
): OAuthClientRecord {
  return {
    id,
    ownerPrincipalId,
    admissionMode: "pre_registered",
    displayName: "RP",
    redirectUris: ["https://victim.example/cb"],
    sectorIdentifier,
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid"],
    allowedResources: [],
    state: "active",
  };
}

describe("pairwise subject sectors across a sector release", () => {
  it("keeps generation 0 on the bare key and sets later ones apart", () => {
    expect(pairwiseSubjectSector("rp.example")).toBe("rp.example");
    expect(pairwiseSubjectSector("rp.example", 0)).toBe("rp.example");
    expect(pairwiseSubjectSector("rp.example", 2)).toBe("rp.example #2");
    // A URL-form key never contains a space, so no key equals a later one.
    expect(pairwiseSubjectSector("rp.example/a", 1)).not.toBe(
      pairwiseSubjectSector("rp.example", 1),
    );
  });

  it("gives the holder after a release fresh subjects, never the squatter's", async () => {
    const clients = new MemoryClientRecordStore();
    const subjects = new MemoryPairwiseSubjectStore();
    const pairwise = createPairwiseIdentifierCallback(subjects, clients);
    const person = "prn_person";

    const squat = await clients.insertAtomic(
      registration("squat", "prn_squatter", "https://victim.example"),
    );
    const squatterSub = await pairwise({}, person, { clientId: squat.id });

    const released = await clients.releaseSectorKey("victim.example");
    expect(released).toEqual({
      sectorKey: "victim.example",
      previousOwnerKey: "prn_squatter",
      generation: 1,
      nextOwnerKey: null,
      blockedClientIds: ["squat"],
    });
    await expect(
      pairwise({}, person, { clientId: squat.id }),
    ).rejects.toMatchObject({ error: "invalid_client" });

    const owner = await clients.insertAtomic(
      registration("owner", "prn_owner", "https://victim.example"),
    );
    expect(owner.sectorGeneration).toBe(1);
    const ownerSub = await pairwise({}, person, { clientId: owner.id });
    expect(ownerSub).not.toBe(squatterSub);
    expect(await pairwise({}, person, { clientId: owner.id })).toBe(ownerSub);
    // Nothing is released twice: the owner's key is live, a stranger's absent.
    expect(await clients.releaseSectorKey("nobody.example")).toBeUndefined();
  });

  it("keeps a release through a full-record update", async () => {
    const clients = new MemoryClientRecordStore();
    const squat = await clients.insertAtomic(
      registration("squat", "prn_squatter", "https://victim.example"),
    );
    await clients.releaseSectorKey("victim.example");
    // What a route writes back: the record it read, minus the store's fields.
    const { sectorKeyBlocked: _b, sectorGeneration: _g, ...plain } = squat;
    const updated = await clients.update({ ...plain, displayName: "Renamed" });
    expect(updated.sectorKeyBlocked).toBe("sector_released");
    expect(updated.displayName).toBe("Renamed");
    // Moving to another sector leaves the block behind with the old key.
    const moved = await clients.update({
      ...plain,
      sectorIdentifier: "https://elsewhere.example",
    });
    expect(moved.sectorKeyBlocked).toBeUndefined();
    expect(moved.sectorGeneration).toBeUndefined();
  });

  it("never lets two owners share a key and generation through a rotation", async () => {
    const clients = new MemoryClientRecordStore();
    const squat = await clients.insertAtomic(
      registration("squat", "prn_squatter", "https://victim.example"),
    );
    // Before any release, another owner cannot join the key.
    await expect(
      clients.insertAtomic(
        registration("early", "prn_owner", "https://victim.example"),
      ),
    ).rejects.toBeInstanceOf(SectorKeyClaimedError);
    await clients.releaseSectorKey("victim.example");
    await clients.insertAtomic(
      registration("owner", "prn_owner", "https://victim.example"),
    );
    // The squatter's rotation: its record under a new id, store fields gone.
    const { sectorKeyBlocked: _b, sectorGeneration: _g, ...plain } = squat;
    await expect(
      clients.insertAtomic({ ...plain, id: "squat-rotated" }),
    ).rejects.toMatchObject({ code: "sector_identifier_taken" });
    const live = (await clients.findBySectorKey("victim.example")).filter(
      (client) => !client.sectorKeyBlocked,
    );
    expect(live.map((client) => client.ownerPrincipalId)).toEqual([
      "prn_owner",
    ]);
  });

  it("holds a released key for a named owner", async () => {
    const clients = new MemoryClientRecordStore();
    await clients.insertAtomic(
      registration("squat", "prn_squatter", "https://victim.example"),
    );
    const released = await clients.releaseSectorKey(
      "victim.example",
      "prn_owner",
    );
    expect(released?.generation).toBe(1);
    await expect(
      clients.insertAtomic(
        registration("again", "prn_squatter", "https://victim.example"),
      ),
    ).rejects.toBeInstanceOf(SectorKeyClaimedError);
    const owner = await clients.insertAtomic(
      registration("owner", "prn_owner", "https://victim.example"),
    );
    expect(owner.sectorGeneration).toBe(1);
  });
});
