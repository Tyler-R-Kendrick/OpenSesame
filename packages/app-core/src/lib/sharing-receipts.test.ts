/**
 * Drop open, live grant and local share receipts name ids only (PF-24).
 * A live grant is pinned in `live/grant-receipt.test.ts`.
 */
/** @vitest-environment jsdom */
import { mintVaultKey, sealDrop } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activitySeams, listActivityEvents } from "./activity-log.js";
import { dropOpenSeams, presentDrop } from "./claims/drop-open.js";
import { listReceipts } from "./device-receipts.js";
import { localRequestFixture } from "./local-request.fixture.js";
import { ensureLocalShare } from "./local-share-grants-approvals.js";
import { createLocalShare, revokeLocalShare } from "./local-share-grants.js";
import {
  flushSharingReceipts,
  noteDropOpened,
  resetSharingReceiptsForTest,
} from "./sharing-receipts.js";
import {
  createLocalDropClaim,
  presentLocalDropClaim,
  resetLocalDropClaimsForTests,
} from "./vault/local-drop-claims.js";
import {
  listOutboundDrops,
  recordOutboundDrop,
  resetOutboundDropsForTests,
  revokeOutboundDrop,
} from "./vault/outbound-drops.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

const LABEL = "LABEL-SHOULD-NOT-LEAK";
const PAYLOAD = "PAYLOAD-SHOULD-NOT-LEAK";
const previousTomb = activitySeams.activeTomb;
const previousPresent = dropOpenSeams.presentClaim;

beforeEach(() => {
  // jsdom's ArrayBuffer is not the one WebAuthn's response is checked against.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  resetSharingReceiptsForTest();
  resetLocalDropClaimsForTests();
  resetOutboundDropsForTests();
  activitySeams.activeTomb = previousTomb;
  dropOpenSeams.presentClaim = previousPresent;
});

afterEach(async () => {
  await flushSharingReceipts();
  resetSharingReceiptsForTest();
  resetLocalDropClaimsForTests();
  resetOutboundDropsForTests();
  activitySeams.activeTomb = previousTomb;
  dropOpenSeams.presentClaim = previousPresent;
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function unlock(): Promise<string> {
  const tomb = `sharing-receipts-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  activitySeams.activeTomb = () => tomb;
  return tomb;
}

async function trails(tomb: string): Promise<string> {
  await flushSharingReceipts();
  return JSON.stringify({
    activity: await listActivityEvents(tomb),
    receipts: await listReceipts(tomb, 20),
  });
}

async function sealedClaim() {
  const { manifest } = await sealDrop({
    kind: "text",
    name: LABEL,
    text: PAYLOAD,
  });
  return { manifest, session: await createLocalDropClaim(manifest, 600_000) };
}

it("records a drop open as the claim id and nothing it carried", async () => {
  const tomb = await unlock();
  const { session } = await sealedClaim();
  const presented = await presentLocalDropClaim(
    session.bearerToken,
    session.userCode,
  );
  expect(presented.state).toBe("consumed");
  // The recipient's present runs in the same tab as the local claim plane.
  dropOpenSeams.presentClaim = async () => ({
    targetManifest: presented.targetManifest,
  });
  await presentDrop(session.bearerToken, "SECOND-CODE-LEAK");

  const blob = await trails(tomb);
  const secret = session.bearerToken.split(".")[1] ?? "";
  expect(secret.length).toBeGreaterThan(0);
  expect(blob).toContain(session.claimId);
  expect(blob).toContain("vault.drop.opened");
  expect(blob).toContain("access.drop.opened");
  expect(blob).not.toContain(secret);
  expect(blob).not.toContain(session.userCode);
  expect(blob).not.toContain("SECOND-CODE-LEAK");
  expect(blob).not.toContain(PAYLOAD);
  expect(blob).not.toContain(LABEL);
  expect(blob).not.toContain("osc_clm_");
  expect(blob.match(/vault\.drop\.opened/gu)).toHaveLength(1);
  expect(blob.match(/access\.drop\.opened/gu)).toHaveLength(1);
});

it("records nothing when the code is wrong or the vault is locked", async () => {
  const tomb = await unlock();
  const { session } = await sealedClaim();
  await expect(
    presentLocalDropClaim(session.bearerToken, "WRONG-CODE"),
  ).rejects.toThrow(/does not match/);
  activitySeams.activeTomb = () => "locked-tomb";
  const opened = await presentLocalDropClaim(
    session.bearerToken,
    session.userCode,
  );
  expect(opened.state).toBe("consumed");
  activitySeams.activeTomb = () => tomb;
  const blob = await trails(tomb);
  expect(blob).not.toContain("drop.opened");
  expect(blob).not.toContain(PAYLOAD);
  expect(blob).not.toContain(session.userCode);
});

it("records a sender revoke and expiry as the claim id only", async () => {
  const tomb = await unlock();
  const revoked = await sealedClaim();
  recordOutboundDrop({
    claimId: revoked.session.claimId,
    bearerToken: revoked.session.bearerToken,
    name: "revoke-me",
    expiresAt: revoked.session.expiresAt,
    sourceItemId: "item_1",
  });
  await revokeOutboundDrop(
    revoked.session.claimId,
    revoked.session.bearerToken,
  );

  const expired = await sealedClaim();
  const expiresAt = new Date(Date.now() + 500).toISOString();
  recordOutboundDrop({
    claimId: expired.session.claimId,
    bearerToken: expired.session.bearerToken,
    name: "expire-me",
    expiresAt,
    sourceItemId: "item_2",
  });
  listOutboundDrops(tomb, Date.now() + 60_000);

  const blob = await trails(tomb);
  expect(blob).toContain(revoked.session.claimId);
  expect(blob).toContain(expired.session.claimId);
  expect(blob).toContain("vault.drop.revoked");
  expect(blob).toContain("access.drop.revoked");
  expect(blob).toContain("vault.drop.expired");
  expect(blob).toContain("access.drop.expired");
  expect(blob).not.toContain("revoke-me");
  expect(blob).not.toContain("expire-me");
});

it("refuses a bearer passed off as a claim id", async () => {
  const tomb = await unlock();
  const { session } = await sealedClaim();
  noteDropOpened(session.bearerToken);
  noteDropOpened(session.claimId);
  const blob = await trails(tomb);
  const secret = session.bearerToken.split(".")[1] ?? "";
  expect(blob).toContain(session.claimId);
  expect(blob).not.toContain(secret);
  expect(blob).not.toContain("osc_clm_");
  expect(blob.match(/vault\.drop\.opened/gu)).toHaveLength(1);
});

it("records a person's share grant and revoke as ids, not the label", async () => {
  const fixture = await localRequestFixture();
  activitySeams.activeTomb = () => fixture.tomb;
  const [share] = await createLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "vault",
    resourceId: "personal",
    resourceLabel: LABEL,
    policy: "open",
    durationSeconds: 3600,
  });
  if (!share) throw new Error("expected a share");
  await revokeLocalShare(fixture.tomb, share.id);
  const blob = await trails(fixture.tomb);
  expect(blob).toContain(share.id);
  expect(blob).toContain(share.principalId);
  expect(blob).toContain("personal");
  expect(blob).toContain("access.share.granted");
  expect(blob).toContain("access.share.revoked");
  expect(blob).not.toContain(LABEL);
  expect(blob.match(/access\.share\.granted/gu)?.length).toBeGreaterThan(0);
  expect(blob.match(/access\.share\.revoked/gu)?.length).toBeGreaterThan(0);
});

it("does not receipt a system share, and a missing revoke writes nothing", async () => {
  const fixture = await localRequestFixture();
  activitySeams.activeTomb = () => fixture.tomb;
  await ensureLocalShare(fixture.tomb, {
    principalId: fixture.personId,
    resourceKind: "vault",
    resourceId: "personal",
    resourceLabel: LABEL,
    policy: "open",
  });
  await expect(
    revokeLocalShare(fixture.tomb, "00000000-0000-4000-8000-000000000000"),
  ).rejects.toThrow(/unavailable/);
  const blob = await trails(fixture.tomb);
  expect(blob).not.toContain("share.granted");
  expect(blob).not.toContain("share.revoked");
  expect(blob).not.toContain(LABEL);
});
