/** @vitest-environment jsdom */
import { configureHost } from "@opensesame/app-core/host.js";
import { activitySeams } from "@opensesame/app-core/lib/activity-log.js";
import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  flushSharingReceipts,
  noteDropRefused,
  resetSharingReceiptsForTest,
} from "@opensesame/app-core/lib/sharing-receipts.js";
import { sealDrop } from "@opensesame/app-core/lib/vault/drop.js";
import {
  createLocalDropClaim,
  localDropClaimSeams,
  resetLocalDropClaimsForTests,
} from "@opensesame/app-core/lib/vault/local-drop-claims.js";
import {
  listOutboundDrops,
  recordOutboundDrop,
  resetOutboundDropsForTests,
  seedOutboundDropForTests,
} from "@opensesame/app-core/lib/vault/outbound-drops.js";
import { unlockTomb } from "@opensesame/app-core/lib/vfs.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import { mintVaultKey } from "@opensesame/vault-core";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { SentDropsPanel } from "./SentDropsPanel.js";
import { renderAccess } from "./workspace-test-support.js";

const realUseVault = vaultHooksSeams.useVault;

installDoublePorts();

function snapshotWithDrops(): CompositionSnapshot {
  const base = double.getSnapshot();
  if (base.plan === null) throw new Error("the double resolves a plan");
  const approved = [...base.plan.approvedCapabilities];
  if (!approved.includes("sharing.drops")) approved.push("sharing.drops");
  const capabilities = { ...base.plan.capabilities };
  const prior = capabilities["sharing.drops"];
  if (prior) {
    capabilities["sharing.drops"] = { ...prior, approved: true };
  }
  return {
    ...base,
    plan: {
      ...base.plan,
      approvedCapabilities: approved,
      capabilities,
    },
  };
}

describe("SentDropsPanel revoke", () => {
  // A new tomb each test: re-unlocking one name seals over the last key,
  // and the next read fails the authentication tag.
  let tomb = "";
  let claimId = "";
  let dropsSnapshot: CompositionSnapshot;

  beforeEach(async () => {
    tomb = `tomb.sent-panel.${crypto.randomUUID()}`;
    configureHost(createTestHost());
    dropsSnapshot = snapshotWithDrops();
    resetLocalDropClaimsForTests();
    resetOutboundDropsForTests();
    localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    activitySeams.activeTomb = () => tomb;
    vaultHooksSeams.useVault = () => ({ ...realUseVault(), tomb });
    Object.assign(capabilityPorts, {
      compositionStore: {
        ...double,
        getSnapshot: () => dropsSnapshot,
      },
    });
    const { manifest } = await sealDrop({
      kind: "text",
      name: "API token",
      text: "secret",
    });
    const session = await createLocalDropClaim(manifest, 600_000);
    claimId = session.claimId;
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
    vaultHooksSeams.useVault = realUseVault;
    resetSharingReceiptsForTest();
    resetLocalDropClaimsForTests();
    resetOutboundDropsForTests();
    clearNotices();
  });

  it("arms revoke on first press and revokes on the second", async () => {
    renderAccess(<SentDropsPanel />, "/access?view=sessions#sent-drops");
    const key = await screen.findByRole("button", { name: "Revoke" });
    await userEvent.click(key);
    expect(key.className).toContain("is-armed");
    expect(listOutboundDrops(tomb)[0]?.state).toBe("pending");
    await userEvent.click(
      await screen.findByRole("button", { name: "Confirm" }),
    );
    await waitFor(() =>
      expect(listOutboundDrops(tomb)[0]?.state).toBe("revoked"),
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

  it("disarms revoke after four seconds like grant revoke", async () => {
    renderAccess(<SentDropsPanel />, "/access?view=sessions#sent-drops");
    const key = await screen.findByRole("button", { name: "Revoke" });
    fireEvent.click(key);
    expect(key.className).toContain("is-armed");
    await waitFor(() => expect(key.className).not.toContain("is-armed"), {
      timeout: 4500,
    });
    expect(listOutboundDrops(tomb)[0]?.state).toBe("pending");
    expect(claimId).toBeTruthy();
  });

  it("shows one refused line whose wrong-code count rises", async () => {
    resetSharingReceiptsForTest();
    noteDropRefused(claimId, 1);
    noteDropRefused(claimId, 2);
    await flushSharingReceipts();
    renderAccess(<SentDropsPanel />, "/access?view=sessions#sent-drops");
    expect(await screen.findByText("Refused · 2 wrong codes")).toBeTruthy();
    expect(screen.getAllByText("Refused · 2 wrong codes")).toHaveLength(1);
  });

  it("keeps a nonlocal send pending and reports unavailable revocation", async () => {
    resetOutboundDropsForTests();
    recordOutboundDrop({
      claimId: "hosted-claim",
      bearerToken: "osc_clm_hosted-claim.secret",
      name: "Hosted fixture",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tomb,
    });
    renderAccess(<SentDropsPanel />, "/access?view=sessions#sent-drops");
    await userEvent.click(
      await screen.findByRole("button", { name: "Revoke" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Confirm" }),
    );
    await waitFor(() =>
      expect(listNotices()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ body: "Revoke unavailable." }),
        ]),
      ),
    );
    expect(listOutboundDrops(tomb)[0]?.state).toBe("pending");
    expect(screen.queryByRole("img", { name: "Revoked" })).toBeNull();
  });

  it("does not repeat an old revoked claim for a portable copy or offer revocation", async () => {
    resetOutboundDropsForTests();
    seedOutboundDropForTests({
      claimId: "portable-old",
      bearerToken: `osc_pdrop_${"A".repeat(22)}.${"B".repeat(43)}`,
      name: "Old portable copy",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      state: "revoked",
      vaultItemId: null,
      sourceItemId: null,
      tomb,
    });
    renderAccess(<SentDropsPanel />, "/access?view=sessions#sent-drops");
    expect(
      await screen.findByRole("img", { name: "Copy shared" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Saved copies can reopen after expiry/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Revoked" })).toBeNull();
  });
});
