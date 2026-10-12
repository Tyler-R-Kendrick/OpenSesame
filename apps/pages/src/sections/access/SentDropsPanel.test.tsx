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
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentDropsPanel } from "./SentDropsPanel.js";
import { renderAccess } from "./workspace-test-support.js";

const revokeOutboundDropByIdMock = vi.fn<
  (claimId: string, tombArg: string) => Promise<"revoked">
>(async () => "revoked");

vi.mock(
  "@opensesame/app-core/lib/vault/outbound-drops.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@opensesame/app-core/lib/vault/outbound-drops.js")
      >();
    return {
      ...actual,
      listOutboundDrops: actual.listOutboundDrops,
      revokeOutboundDropById: (claimId: string, tombArg: string) =>
        revokeOutboundDropByIdMock(claimId, tombArg),
    };
  },
);

vi.mock("../../app-root.js", () => ({
  useCapabilityGate: () => ({ approved: true }),
}));

vi.mock("../../lib/vault/hooks.js", () => ({
  useVault: () => ({ tomb: "tomb.sent-panel" }),
}));

describe("SentDropsPanel revoke", () => {
  const tomb = "tomb.sent-panel";

  beforeEach(async () => {
    revokeOutboundDropByIdMock.mockClear();
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

  it("arms revoke on first press and revokes on the second", async () => {
    renderAccess(<SentDropsPanel />, "/access?view=sessions#sent-drops");
    const key = await screen.findByRole("button", { name: "Revoke" });
    await userEvent.click(key);
    expect(key.className).toContain("is-armed");
    expect(revokeOutboundDropByIdMock).not.toHaveBeenCalled();
    await userEvent.click(
      await screen.findByRole("button", { name: "Confirm" }),
    );
    await waitFor(() =>
      expect(revokeOutboundDropByIdMock).toHaveBeenCalledOnce(),
    );
  });

  it("disarms revoke on blur", async () => {
    renderAccess(<SentDropsPanel />, "/access?view=sessions#sent-drops");
    const key = await screen.findByRole("button", { name: "Revoke" });
    await userEvent.click(key);
    expect(key.className).toContain("is-armed");
    fireEvent.blur(key);
    await waitFor(() => expect(key.className).not.toContain("is-armed"));
  });
});
