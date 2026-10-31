import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activitySeams } from "../activity-log.js";
import { sealDrop } from "./drop.js";
import {
  createLocalDropClaim,
  localDropClaimSeams,
  presentLocalDropClaim,
  resetLocalDropClaimsForTests,
} from "./local-drop-claims.js";
import {
  listOutboundDrops,
  outboundDropBearerForTests,
  outboundDropRowStateForTests,
  recordOutboundDrop,
  refreshOutboundDropLedger,
  resetOutboundDropsForTests,
  revokeOutboundDrop,
  revokeOutboundDropById,
  seedOutboundDropForTests,
} from "./outbound-drops.js";
import {
  createPortableDropSession,
  openPortableDropBundle,
} from "./portable-drop.js";

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

  it("does not claim a portable link was revoked when its sender row is present", async () => {
    const manifest = { kind: "secret-drop", ciphertext: "fixture" };
    const session = await createPortableDropSession(
      manifest,
      600_000,
      "https://example.test/claim",
    );
    recordOutboundDrop({ ...session, name: "portable" });
    await expect(revokeOutboundDropById(session.claimId, TOMB_A)).resolves.toBe(
      "missing",
    );
    expect(listOutboundDrops(TOMB_A)[0]?.state).toBe("pending");
    await expect(
      openPortableDropBundle(
        session.pkt,
        session.bearerToken,
        session.userCode,
      ),
    ).resolves.toEqual(manifest);
  });

  it("does not substitute a local ledger update for a missing hosted claim", async () => {
    recordOutboundDrop({
      claimId: "remote-claim",
      bearerToken: "osc_clm_remote-claim.secret",
      name: "remote",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(revokeOutboundDropById("remote-claim", TOMB_A)).resolves.toBe(
      "missing",
    );
    expect(listOutboundDrops(TOMB_A)[0]?.state).toBe("pending");
  });

  it("does not retain unconfirmed revocation claims from older clients", () => {
    seedOutboundDropForTests({
      claimId: "legacy-remote",
      bearerToken: "osc_clm_legacy-remote.secret",
      name: "legacy remote",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      state: "revoked",
      vaultItemId: null,
      sourceItemId: null,
      tomb: TOMB_A,
    });
    expect(listOutboundDrops(TOMB_A)[0]?.state).toBe("pending");
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

  it("marks the sender ledger locked out after too many wrong codes", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "locked",
      text: "x",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    recordOutboundDrop({
      claimId: session.claimId,
      bearerToken: session.bearerToken,
      name: "locked",
      expiresAt: session.expiresAt,
      sourceItemId: "item_1",
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(
        presentLocalDropClaim(session.bearerToken, "WRONG-CODE"),
      ).rejects.toThrow();
    }
    expect(listOutboundDrops(TOMB_A)[0]?.state).toBe("locked_out");
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
