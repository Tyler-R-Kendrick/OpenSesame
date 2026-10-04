/**
 * What the request ceremony writes to the receipts (ADR 0162): one line for a
 * request raised, approved, denied or withdrawn, ids only, and none for a
 * decision that was refused.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listReceipts } from "./device-receipts.js";
import {
  createLocalAccessRequest,
  decideLocalAccessRequest,
  revokeLocalAccessRequest,
} from "./local-access-requests.js";
import { localRequestFixture } from "./local-request.fixture.js";
import type { LocalSession } from "./local-sessions.js";
import { vaultStore } from "./vault/store.js";

let tomb: string;
let personId: string;
let applicationId: string;
let organizationId: string;
let session: LocalSession;

function createRequest() {
  return createLocalAccessRequest(tomb, session, {
    applicationId,
    redirectUri: "https://rp.example.test/callback",
    scopes: ["openid"],
    reason: "Sign in to the test application",
  });
}

beforeEach(async () => {
  ({ tomb, personId, applicationId, organizationId, session } =
    await localRequestFixture());
});
afterEach(() => {
  vaultStore.lock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("writes a receipt for a request raised, approved, denied and withdrawn, and for no decision that was refused", async () => {
  const kinds = async () =>
    (await listReceipts(tomb, 20)).map((row) => row.eventType);
  const first = await createRequest();
  expect(await kinds()).toEqual(["access.request.created"]);
  const approved = await decideLocalAccessRequest(tomb, {
    ...first,
    principalId: personId,
    decision: "approve",
  });
  await revokeLocalAccessRequest(tomb, approved);
  const second = await createRequest();
  await decideLocalAccessRequest(tomb, {
    ...second,
    principalId: personId,
    decision: "deny",
  });
  const [denied, , withdrawn, approvedReceipt, created] = await listReceipts(
    tomb,
    20,
  );
  expect(await kinds()).toEqual([
    "access.request.denied",
    "access.request.created",
    "access.request.withdrawn",
    "access.request.approved",
    "access.request.created",
  ]);
  expect(denied?.outcome).toBe("denied");
  expect(withdrawn?.outcome).toBe("succeeded");
  // The approver is named; the request and its requester are ids.
  expect(approvedReceipt?.metadata).toMatchObject({
    authReqId: first.id,
    subject: personId,
    actor: personId,
    organizationId,
    targetType: "application",
    targetId: applicationId,
  });
  expect(created?.metadata).not.toHaveProperty("actor");
  // Nothing a request holds beyond ids reaches the trail.
  const text = JSON.stringify(await listReceipts(tomb, 20));
  for (const content of [
    first.reason,
    first.redirectUri,
    first.requestDigest,
    "openid",
  ])
    expect(text).not.toContain(content);
  // A decision that was refused is not a receipt.
  await expect(
    decideLocalAccessRequest(tomb, {
      ...second,
      principalId: personId,
      decision: "approve",
    }),
  ).rejects.toThrow();
  expect((await listReceipts(tomb, 20)).length).toBe(5);
});
