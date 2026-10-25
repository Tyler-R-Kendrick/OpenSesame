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
import {
  ensureLocalShare,
  submitLocalShare,
} from "./local-share-grants-approvals.js";
import { createLocalShare, revokeLocalShare } from "./local-share-grants.js";
import {
  flushSharingReceipts,
  noteDropOpened,
  noteDropRefused,
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
  refreshOutboundDropLedger,
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

it("queues an expiry receipt while locked and flushes once on unlock", async () => {
  const tombA = await unlock();
  const vaultKey = (await mintVaultKey()).vaultKey;
  const tombB = `sharing-receipts-b-${crypto.randomUUID()}`;
  unlockTomb(tombB, (await mintVaultKey()).vaultKey);
  const expired = await sealedClaim();
  const expiresAt = new Date(Date.now() + 500).toISOString();
  recordOutboundDrop({
    claimId: expired.session.claimId,
    bearerToken: expired.session.bearerToken,
    name: "expire-locked",
    expiresAt,
    sourceItemId: "item_lock",
    tomb: tombA,
  });
  lockAllTombs();
  activitySeams.activeTomb = () => null;
  listOutboundDrops(tombA, Date.now() + 60_000);
  unlockTomb(tombA, vaultKey);
  activitySeams.activeTomb = () => tombA;
  refreshOutboundDropLedger();
  await flushSharingReceipts();
  let blob = await trails(tombA);
  expect(blob).toContain("vault.drop.expired");
  expect(blob.match(/vault\.drop\.expired/gu)).toHaveLength(1);
  refreshOutboundDropLedger();
  await flushSharingReceipts();
  blob = await trails(tombA);
  expect(blob.match(/vault\.drop\.expired/gu)).toHaveLength(1);
  const tombBKey = (await mintVaultKey()).vaultKey;
  unlockTomb(tombB, tombBKey);
  activitySeams.activeTomb = () => tombB;
  refreshOutboundDropLedger();
  await flushSharingReceipts();
  blob = await trails(tombB);
  expect(blob).not.toContain("vault.drop.expired");
});

it("records drop sent when the sender logs the outbound drop", async () => {
  const tomb = await unlock();
  const { session } = await sealedClaim();
  recordOutboundDrop({
    claimId: session.claimId,
    bearerToken: session.bearerToken,
    name: "sent",
    expiresAt: session.expiresAt,
    sourceItemId: "item_sent",
    tomb,
  });
  const blob = await trails(tomb);
  expect(blob).toContain("vault.drop.sent");
  expect(blob).toContain("access.drop.sent");
  expect(blob).toContain(session.claimId);
  expect(blob).toContain("item_sent");
  expect(blob).not.toContain('"name":"sent"');
});

it("records share requested when an agent grant is pending", async () => {
  const fixture = await localRequestFixture();
  activitySeams.activeTomb = () => fixture.tomb;
  const submitted = await submitLocalShare(fixture.tomb, {
    principalId: fixture.applicationId,
    resourceKind: "folder",
    resourceId: "fold-receipt",
    resourceLabel: "Work",
    policy: "read",
    durationSeconds: 3600,
  });
  if (submitted.outcome !== "pending") throw new Error("expected pending");
  const blob = await trails(fixture.tomb);
  expect(blob).toContain("access.share.requested");
  expect(blob).toContain(submitted.pending.id);
  expect(blob).toContain(fixture.applicationId);
  expect(blob).toContain("fold-receipt");
  expect(blob).not.toContain("Work");
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

it("records sender refused when a tracked send cannot be presented", async () => {
  const tomb = await unlock();
  const { session } = await sealedClaim();
  recordOutboundDrop({
    claimId: session.claimId,
    bearerToken: session.bearerToken,
    name: "refused-send",
    expiresAt: session.expiresAt,
    sourceItemId: "item_refused",
    tomb,
  });
  resetLocalDropClaimsForTests();
  await expect(
    presentDrop(session.bearerToken, session.userCode),
  ).rejects.toThrow();
  const blob = await trails(tomb);
  expect(blob).toContain(session.claimId);
  expect(blob).toContain("vault.drop.refused");
  expect(blob).toContain("access.drop.refused");
  expect(blob).toContain("Drop refused");
  expect(blob).not.toContain("wrong code");
});

it("records a drop open on the sending vault when another vault presents", async () => {
  const tombA = await unlock();
  const tombB = `sharing-receipts-b-${crypto.randomUUID()}`;
  unlockTomb(tombB, (await mintVaultKey()).vaultKey);
  const { session } = await sealedClaim();
  recordOutboundDrop({
    claimId: session.claimId,
    bearerToken: session.bearerToken,
    name: "cross-vault-open",
    expiresAt: session.expiresAt,
    sourceItemId: "item_cross",
    tomb: tombA,
  });
  activitySeams.activeTomb = () => tombB;
  const presented = await presentLocalDropClaim(
    session.bearerToken,
    session.userCode,
  );
  dropOpenSeams.presentClaim = async () => ({
    targetManifest: presented.targetManifest,
  });
  await presentDrop(session.bearerToken, session.userCode);
  const blobA = await trails(tombA);
  expect(blobA).toContain("vault.drop.opened");
  expect(blobA.match(/vault\.drop\.opened/gu)).toHaveLength(1);
  activitySeams.activeTomb = () => tombB;
  const blobB = await trails(tombB);
  expect(blobB).toContain("vault.drop.opened");
  expect(blobB.match(/vault\.drop\.opened/gu)).toHaveLength(1);
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

it("keeps one refused receipt while the wrong-code count rises", async () => {
  const tomb = await unlock();
  const { session } = await sealedClaim();
  recordOutboundDrop({
    claimId: session.claimId,
    bearerToken: session.bearerToken,
    name: "tally",
    expiresAt: session.expiresAt,
    sourceItemId: "item_tally",
    tomb,
  });
  noteDropRefused(session.claimId);
  noteDropRefused(session.claimId);
  for (let i = 0; i < 4; i += 1) {
    await expect(
      presentLocalDropClaim(session.bearerToken, "WRONG-CODE"),
    ).rejects.toMatchObject({ wire: "invalid_user_code" });
  }
  const beforeLockout = await trails(tomb);
  expect(beforeLockout).toContain("Refused · 4 wrong codes");
  expect(beforeLockout).toContain('"count":4');
  expect(beforeLockout).not.toContain("drop.locked_out");
  await expect(
    presentLocalDropClaim(session.bearerToken, "WRONG-CODE"),
  ).rejects.toMatchObject({ wire: "too_many_attempts" });
  await expect(
    presentLocalDropClaim(session.bearerToken, session.userCode),
  ).rejects.toMatchObject({ wire: "too_many_attempts" });
  const blob = await trails(tomb);
  expect(blob.match(/vault\.drop\.refused/gu)).toHaveLength(1);
  expect(blob.match(/access\.drop\.refused/gu)).toHaveLength(1);
  expect(blob.match(/access\.drop\.locked_out/gu)).toHaveLength(1);
  expect(blob).toContain("Refused · 4 wrong codes");
  expect(blob).toContain('"count":4');
  expect(blob).not.toContain(session.userCode);
});
