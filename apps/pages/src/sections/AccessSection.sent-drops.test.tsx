/** @vitest-environment jsdom */
import { activitySeams } from "@opensesame/app-core/lib/activity-log.js";
import { sealDrop } from "@opensesame/app-core/lib/vault/drop.js";
import {
  createLocalDropClaim,
  localDropClaimSeams,
  resetLocalDropClaimsForTests,
} from "@opensesame/app-core/lib/vault/local-drop-claims.js";
import {
  recordOutboundDrop,
  resetOutboundDropsForTests,
} from "@opensesame/app-core/lib/vault/outbound-drops.js";
import { unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import { mintVaultKey } from "@opensesame/vault-core";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessSection } from "./AccessSection.js";
import { renderAccess } from "./access/workspace-test-support.js";

vi.mock("../app-root.js", () => ({
  useCapabilityGate: () => ({ approved: true }),
}));

vi.mock("../lib/use-configured.js", () => ({
  useIdentityConfigured: () => false,
}));

vi.mock("../lib/use-online.js", () => ({
  useOnline: () => true,
}));

describe("AccessSection sent drops", () => {
  const tomb = "sent-drops-access";

  beforeEach(async () => {
    resetLocalDropClaimsForTests();
    resetOutboundDropsForTests();
    localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    activitySeams.activeTomb = () => tomb;
    const { manifest } = await sealDrop({
      kind: "text",
      name: "API token",
      text: "secret",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    recordOutboundDrop({
      claimId: session.claimId,
      bearerToken: session.bearerToken,
      name: "API token",
      expiresAt: session.expiresAt,
      sourceItemId: "item_1",
      tomb,
    });
  });

  afterEach(() => {
    cleanup();
    resetLocalDropClaimsForTests();
    resetOutboundDropsForTests();
  });

  it("opens the Sent panel from sessions#sent-drops", async () => {
    renderAccess(<AccessSection />, "/access?view=sessions#sent-drops");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Sent" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "Revoke this send" }),
    ).toBeTruthy();
  });
});
