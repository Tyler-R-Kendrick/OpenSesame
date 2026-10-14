/** @vitest-environment jsdom */
import { configureHost } from "@opensesame/app-core/host.js";
import { activitySeams } from "@opensesame/app-core/lib/activity-log.js";
import { createTestHost } from "@opensesame/app-core/test-host.js";
import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  double,
  installDoublePorts,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useOnlineSeams } from "../lib/use-online.js";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { AccessSection } from "./AccessSection.js";
import { renderAccess } from "./access/workspace-test-support.js";

const realUseVault = vaultHooksSeams.useVault;
const realUseOnline = useOnlineSeams.useOnline;

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

describe("AccessSection sent drops", () => {
  const tomb = "sent-drops-access";
  let dropsSnapshot: CompositionSnapshot;

  beforeEach(async () => {
    configureHost(createTestHost());
    dropsSnapshot = snapshotWithDrops();
    resetLocalDropClaimsForTests();
    resetOutboundDropsForTests();
    localDropClaimSeams.claimBase = () => "http://localhost:5180/OpenSesame";
    unlockTomb(tomb, (await mintVaultKey()).vaultKey);
    activitySeams.activeTomb = () => tomb;
    vaultHooksSeams.useVault = () => ({ ...realUseVault(), tomb });
    useOnlineSeams.useOnline = () => true;
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
    useOnlineSeams.useOnline = realUseOnline;
    resetLocalDropClaimsForTests();
    resetOutboundDropsForTests();
  });

  it("opens the Sent panel from sessions#sent-drops", async () => {
    renderAccess(<AccessSection />, "/access?view=sessions#sent-drops");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Sent" })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  });
});
