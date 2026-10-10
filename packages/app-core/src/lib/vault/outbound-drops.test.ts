import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activitySeams } from "../activity-log.js";
import { sealDrop } from "./drop.js";
import {
  createLocalDropClaim,
  localDropClaimSeams,
  resetLocalDropClaimsForTests,
} from "./local-drop-claims.js";
import {
  listOutboundDrops,
  outboundDropBearerForTests,
  recordOutboundDrop,
  refreshOutboundDropLedger,
  resetOutboundDropsForTests,
  revokeOutboundDrop,
  outboundDropRowStateForTests,
  revokeOutboundDropById,
  seedOutboundDropForTests,
} from "./outbound-drops.js";

const TOMB_A = "tomb/vault-a";
const TOMB_B = "tomb/vault-b";

beforeEach(() => {
  resetLocalDropClaimsForTests();
  resetOutboundDropsForTests();
  localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
  activitySeams.activeTomb = () => TOMB_A;
});

afterEach(() => {
  resetLocalDropClaimsForTests();
  resetOutboundDropsForTests();
  localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
});

describe("outbound drop sender ledger", () => {
  it("revokes a recorded send and marks the ledger revoked", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "API token",
      text: "secret-value",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    recordOutboundDrop({
      claimId: session.claimId,
      bearerToken: session.bearerToken,
      name: "API token",
      expiresAt: session.expiresAt,
      sourceItemId: "item_secret",
    });
    expect(listOutboundDrops(TOMB_A)).toMatchObject([
      { claimId: session.claimId, state: "pending" },
    ]);
    await revokeOutboundDrop(session.claimId, session.bearerToken);
    expect(listOutboundDrops(TOMB_A)[0]?.state).toBe("revoked");
  });

  it("links manual records to local claims", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "manual",
      text: "x",
    });
    const session = await createLocalDropClaim(manifest, 60_000);
    recordOutboundDrop({
      claimId: session.claimId,
      bearerToken: session.bearerToken,
      name: "manual",
      expiresAt: session.expiresAt,
      sourceItemId: "item_1",
    });
    expect(outboundDropBearerForTests(session.claimId)).toBe(
      session.bearerToken,
    );
  });

  it("scopes the ledger to the sealing vault", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "scoped",
      text: "x",
    });
    const session = await createLocalDropClaim(manifest, 60_000);
    recordOutboundDrop({
      claimId: session.claimId,
      bearerToken: session.bearerToken,
      name: "scoped",
      expiresAt: session.expiresAt,
      sourceItemId: "item_1",
      tomb: TOMB_A,
    });
    expect(listOutboundDrops(TOMB_B)).toEqual([]);
    expect(listOutboundDrops(TOMB_A)).toHaveLength(1);
    expect(await revokeOutboundDropById(session.claimId, TOMB_B)).toBe(
      "missing",
    );
    expect(listOutboundDrops(TOMB_A)[0]?.state).toBe("pending");
  });

  it("expires legacy rows without tomb through refreshOutboundDropLedger", async () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    seedOutboundDropForTests({
      claimId: "clm_legacy",
      bearerToken: "bearer_legacy",
      name: "legacy",
      expiresAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      state: "pending",
      vaultItemId: null,
      sourceItemId: null,
    });
    expect(listOutboundDrops(TOMB_A)).toEqual([]);
    refreshOutboundDropLedger();
    expect(outboundDropRowStateForTests("clm_legacy")).toBe("expired");
    expect(listOutboundDrops(TOMB_A)).toEqual([]);
  });
});
