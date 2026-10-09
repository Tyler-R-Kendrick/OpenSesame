import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  resetOutboundDropsForTests,
  revokeOutboundDrop,
} from "./outbound-drops.js";

beforeEach(() => {
  resetLocalDropClaimsForTests();
  resetOutboundDropsForTests();
  localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
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
    expect(listOutboundDrops()).toMatchObject([
      { claimId: session.claimId, state: "pending" },
    ]);
    await revokeOutboundDrop(session.claimId, session.bearerToken);
    expect(listOutboundDrops()[0]?.state).toBe("revoked");
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
});
