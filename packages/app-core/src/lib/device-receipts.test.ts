/**
 * Receipts of what this device decided (ADR 0162): which decisions write one,
 * what a receipt may name, and that none is ever edited or lost to a failure
 * of the decision it records.
 */

import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import {
  RECEIPT_KINDS,
  type ReceiptKind,
  type ReceiptRef,
  flushReceipts,
  grantRef,
  listReceipts,
  recordReceipt,
  requestRef,
  resetHeldReceiptsForTest,
  sessionRef,
} from "./device-receipts.js";
import { listAccessAuditEvents } from "./local-access-audit.js";
import { subscribeLocalIamChanges } from "./local-iam-events.js";
import { lockAllTombs, readFile, unlockTomb, writeFile } from "./vfs.js";

let tomb: string;

beforeEach(async () => {
  tomb = `receipts-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
});

afterEach(() => {
  resetHeldReceiptsForTest();
  lockAllTombs();
  vi.unstubAllGlobals();
});

/** Every decision a receipt can record, once. */
const KINDS = [
  "request.created",
  "request.approved",
  "request.denied",
  "request.withdrawn",
  "sign_in.granted",
  "sign_in.denied",
  "sign_in.revoked",
  "session.ended",
  "siop.approved",
  "siop.denied",
  "drop.opened",
  "drop.expired",
  "drop.locked_out",
  "drop.revoked",
  "live.granted",
  "share.granted",
  "share.revoked",
] as const satisfies readonly ReceiptKind[];

const APP = "local_11111111-1111-4111-8111-111111111111";
const PERSON = "local_22222222-2222-4222-8222-222222222222";
const ORG = "local_33333333-3333-4333-8333-333333333333";

describe("the decisions a receipt can record", () => {
  it("is a closed table: each kind is one event name and one outcome", () => {
    expect(Object.keys(RECEIPT_KINDS).sort()).toEqual([...KINDS].sort());
    const names = Object.values(RECEIPT_KINDS).map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reads a refusal as denied and everything else as succeeded", async () => {
    for (const kind of KINDS)
      await recordReceipt(tomb, kind, { applicationId: APP });
    const byType = new Map(
      (await listReceipts(tomb, 50)).map((row) => [row.eventType, row.outcome]),
    );
    for (const [kind, [name, outcome]] of Object.entries(RECEIPT_KINDS)) {
      expect(byType.get(name), kind).toBe(outcome);
    }
    expect(
      [...byType.values()].filter((value) => value === "denied"),
    ).toHaveLength(4);
  });
});

describe("what a receipt names", () => {
  it.each([
    { ref: { applicationId: APP }, targetType: "application", targetId: APP },
    { ref: { sessionOf: PERSON }, targetType: "principal", targetId: PERSON },
    { ref: { claimId: "claim-id" }, targetType: "claim", targetId: "claim-id" },
    { ref: { shareId: "share-id" }, targetType: "share", targetId: "share-id" },
    {
      ref: { liveSessionId: "live-id" },
      targetType: "live_session",
      targetId: "live-id",
    },
    { ref: { claimId: "" }, targetType: "claim", targetId: "" },
  ] satisfies readonly {
    ref: ReceiptRef;
    targetType: string;
    targetId: string;
  }[])(
    "preserves the $targetType target chosen by its typed subject",
    async ({ ref, targetType, targetId }) => {
      await recordReceipt(tomb, "request.approved", ref);
      const [receipt] = await listReceipts(tomb, 1);
      expect(receipt.metadata.targetType).toBe(targetType);
      expect(receipt.metadata.targetId).toBe(targetId);
    },
  );

  it("is ids and a closed enum, never a scope, a reason or an address", async () => {
    await recordReceipt(tomb, "request.approved", {
      ...requestRef({
        id: "9f1c1a3e-7d1d-4f56-9f6f-2f9e0a0d4c11",
        applicationId: APP,
        requesterId: PERSON,
        organizationId: ORG,
      }),
      actor: PERSON,
    });
    const [receipt] = await listReceipts(tomb, 1);
    expect(receipt?.metadata).toEqual({
      authReqId: "9f1c1a3e-7d1d-4f56-9f6f-2f9e0a0d4c11",
      subject: PERSON,
      actor: PERSON,
      organizationId: ORG,
      targetType: "application",
      targetId: APP,
    });
  });

  it("drops a key the trail's allowlist does not carry", async () => {
    // A caller cannot smuggle a field in through the type, and one that gets
    // past it (an object built elsewhere) is dropped by the redactor.
    const smuggled = {
      ...grantRef({
        applicationId: APP,
        principalId: PERSON,
        organizationId: ORG,
      }),
      redirectUri: "https://rp.example.test/callback",
    };
    await recordReceipt(tomb, "sign_in.granted", smuggled);
    const [receipt] = await listReceipts(tomb, 1);
    expect(JSON.stringify(receipt)).not.toContain("rp.example.test");
  });
});

describe("the trail", () => {
  it("is newest first and never edits what it already holds", async () => {
    await recordReceipt(tomb, "request.created", { applicationId: APP });
    const [first] = await listReceipts(tomb, 10);
    await recordReceipt(tomb, "request.approved", { applicationId: APP });
    await recordReceipt(tomb, "sign_in.granted", { applicationId: APP });
    const rows = await listReceipts(tomb, 10);
    expect(rows.map((row) => row.eventType)).toEqual([
      "access.sign_in.granted",
      "access.request.approved",
      "access.request.created",
    ]);
    expect(rows[2]).toEqual(first);
  });

  it("returns at most the limit asked for", async () => {
    for (let at = 0; at < 4; at += 1)
      await recordReceipt(tomb, "request.created", { applicationId: APP });
    expect(await listReceipts(tomb, 2)).toHaveLength(2);
    expect(await listReceipts(tomb, 0)).toEqual([]);
  });

  it("never fails the decision it records", async () => {
    lockAllTombs();
    await expect(
      recordReceipt(tomb, "request.approved", { applicationId: APP }),
    ).resolves.toBeUndefined();
  });
});

const TRAIL = "config/device-receipts";
const AUDIT = "config/access-audit";
const bytes = (text: string) => new TextEncoder().encode(text);

describe("where receipts live", () => {
  it("is a file of their own: the Access audit is never touched", async () => {
    const before = JSON.stringify({ version: 1, events: [] });
    await writeFile(tomb, AUDIT, bytes(before));
    await recordReceipt(tomb, "request.created", { applicationId: APP });
    await recordReceipt(tomb, "sign_in.revoked", { applicationId: APP });
    // Byte for byte what an older build wrote, and readable by one.
    expect(new TextDecoder().decode(await readFile(tomb, AUDIT))).toBe(before);
    expect(await listAccessAuditEvents(tomb)).toEqual([]);
    expect(await listReceipts(tomb, 10)).toHaveLength(2);
  });

  it("records the end of a session against the person it was for", async () => {
    await recordReceipt(
      tomb,
      "session.ended",
      sessionRef({ principalId: PERSON }),
    );
    const [receipt] = await listReceipts(tomb, 1);
    expect(receipt?.eventType).toBe("access.session.revoked");
    expect(receipt?.metadata).toEqual({
      subject: PERSON,
      targetType: "principal",
      targetId: PERSON,
    });
  });
});

describe("telling the other readers", () => {
  it("announces a receipt that was written, once, and nothing for a read that found none", async () => {
    const heard = vi.fn();
    const off = subscribeLocalIamChanges(heard);
    await listReceipts(tomb, 10);
    await flushReceipts(tomb);
    expect(heard).not.toHaveBeenCalled();
    await recordReceipt(tomb, "request.created", { applicationId: APP });
    expect(heard).toHaveBeenCalledOnce();
    // Reading the trail again, however often, is not a change: two tabs that
    // each read when the other changes would otherwise read each other forever.
    await listReceipts(tomb, 10);
    await flushReceipts(tomb);
    expect(heard).toHaveBeenCalledOnce();
    off();
  });
});
