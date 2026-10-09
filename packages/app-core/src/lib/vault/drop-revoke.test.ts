import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revokeDropVaultItem } from "./drop-revoke.js";
import { sealDrop } from "./drop.js";
import {
  createLocalDropClaim,
  localDropClaimSeams,
  pollLocalDropClaim,
  resetLocalDropClaimsForTests,
} from "./local-drop-claims.js";
import { resetOutboundDropsForTests } from "./outbound-drops.js";

beforeEach(() => {
  resetLocalDropClaimsForTests();
  resetOutboundDropsForTests();
  localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
});

afterEach(() => {
  resetLocalDropClaimsForTests();
  resetOutboundDropsForTests();
});

describe("revokeDropVaultItem", () => {
  it("revokes the local claim for a vault drop record", async () => {
    const { manifest } = await sealDrop({
      kind: "text",
      name: "Deploy",
      text: "tok",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    const drop = {
      ...createItem("drop", "Deploy"),
      claimId: session.claimId,
      bearerToken: session.bearerToken,
      expiresAt: session.expiresAt,
      state: "pending" as const,
    };
    await revokeDropVaultItem(drop);
    await expect(
      pollLocalDropClaim(session.claimId, session.bearerToken),
    ).resolves.toBe("revoked");
  });
});
