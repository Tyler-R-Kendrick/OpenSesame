/**
 * What an owner does with a circle that exists (ADR 0186 §10): ask its
 * contacts to approve sharing something, collect their approvals, carry the
 * share out once they have, cancel a request, or retire the circle.
 */

import type { LocalShare } from "../../local-share-grants.js";
import { toB64url } from "../bytes.js";
import { signCancellation } from "../cancellation.js";
import { assertGrantWritable, grantFromQuorum } from "../grant.js";
import { generateKeyPair } from "../hpke.js";
import type { LedgerStatus, Outcome } from "../ledger-types.js";
import { QuorumLedger } from "../ledger.js";
import { decodePacket, encodePacket } from "../packets.js";
import { checkRequest, createRequest, requestDigest } from "../request.js";
import type { Grant, QuorumRequest } from "../types.js";
import {
  type Ask,
  AskSchema,
  KEYS,
  load,
  plainSnapshot,
  save,
} from "./docs.js";
import { forgetDealt } from "./owner-dealt.js";
import { DeskError, type DeskPorts, type OwnedRecord } from "./ports.js";

async function owned(ports: DeskPorts, circleId: string): Promise<OwnedRecord> {
  const found = (await ports.records.owned()).find(
    (r) => r.signedPolicy.policy.circleId === circleId,
  );
  if (!found) throw new DeskError("no_circle", "no such circle");
  return found;
}

function ledgerOf(ports: DeskPorts, ask: Ask, record: OwnedRecord) {
  const ledger = QuorumLedger.open(record.signedPolicy, ask.request, () =>
    ports.now().getTime(),
  );
  ledger.restore(ask.snapshot);
  return ledger;
}

async function loadAsk(ports: DeskPorts, digest: string): Promise<Ask> {
  const ask = await load(ports.pending, KEYS.ask(digest), AskSchema);
  if (!ask) throw new DeskError("no_ask", "no such request");
  return ask;
}

export type AskView = Readonly<{
  digest: string;
  request: QuorumRequest;
  /** The request as one line of text for the contacts. */
  packet: string;
  status: LedgerStatus;
  approvedBy: readonly string[];
}>;

function viewOf(ledger: QuorumLedger, digest: string): AskView {
  return {
    digest,
    request: ledger.request,
    packet: encodePacket({ kind: "request", value: ledger.request }),
    status: ledger.status(),
    approvedBy: ledger.approvedGuardians(),
  };
}

/** Ask the circle to approve sharing something with a person. The share is written only after they have. */
export async function askToShare(
  ports: DeskPorts,
  circleId: string,
  grant: Grant,
): Promise<AskView> {
  const record = await owned(ports, circleId);
  assertGrantWritable(grant);
  const request = createRequest({
    signedPolicy: record.signedPolicy,
    operation: "grant-access",
    grant,
    // A grant releases no share; the request still names a key, so it gets one it never uses.
    recipientPublicKey: toB64url(generateKeyPair().publicKey),
    recipientLabel: grant.principalId,
    now: ports.now(),
  });
  const ledger = QuorumLedger.open(record.signedPolicy, request, () =>
    ports.now().getTime(),
  );
  const digest = requestDigest(request);
  await save(ports.pending, KEYS.ask(digest), AskSchema, {
    v: 1,
    circleId,
    request,
    snapshot: plainSnapshot(ledger.snapshot()),
  });
  return viewOf(ledger, digest);
}

export type Collected = Readonly<{
  outcomes: readonly Outcome[];
  view: AskView;
}>;

/** Approvals pasted from contacts: one approval packet or the list of them. */
export async function collectApprovals(
  ports: DeskPorts,
  digest: string,
  packet: string,
): Promise<Collected> {
  const ask = await loadAsk(ports, digest);
  const record = await owned(ports, ask.circleId);
  const ledger = ledgerOf(ports, ask, record);
  const decoded = decodePacket(packet);
  const approvals =
    decoded.kind === "approval"
      ? [decoded.value]
      : decoded.kind === "approvals"
        ? decoded.value
        : null;
  if (!approvals) {
    throw new DeskError("kind", `this is a ${decoded.kind}, not an approval`);
  }
  const outcomes: Outcome[] = [];
  for (const approval of approvals) {
    outcomes.push(await ledger.submitApproval(approval));
  }
  await save(ports.pending, KEYS.ask(digest), AskSchema, {
    ...ask,
    snapshot: plainSnapshot(ledger.snapshot()),
  });
  return { outcomes, view: viewOf(ledger, digest) };
}

export async function askStatus(
  ports: DeskPorts,
  digest: string,
): Promise<AskView> {
  const ask = await loadAsk(ports, digest);
  const record = await owned(ports, ask.circleId);
  return viewOf(ledgerOf(ports, ask, record), digest);
}

export async function pendingAsks(
  ports: DeskPorts,
  circleId: string,
): Promise<readonly AskView[]> {
  const keys = await ports.pending.list("ask:");
  const views: AskView[] = [];
  for (const key of keys) {
    const digest = key.slice("ask:".length);
    const ask = await load(ports.pending, key, AskSchema);
    if (ask?.circleId === circleId) views.push(await askStatus(ports, digest));
  }
  return views;
}

/** Carry out what the circle approved: write the share, once. */
export async function applyAsk(
  ports: DeskPorts,
  digest: string,
): Promise<readonly LocalShare[]> {
  const ask = await loadAsk(ports, digest);
  const record = await owned(ports, ask.circleId);
  const ledger = ledgerOf(ports, ask, record);
  const shares = await grantFromQuorum({
    tomb: ports.tomb,
    ledger,
    now: ports.now().getTime(),
  });
  await save(ports.pending, KEYS.ask(digest), AskSchema, {
    ...ask,
    snapshot: plainSnapshot(ledger.snapshot()),
  });
  return shares;
}

/** A cancellation, and the request it ends. */
export type Cancelled = Readonly<{ digest: string; packet: string }>;

/**
 * Cancel a request, signed with the owner key. The packet goes to every
 * contact who has seen the request; a guardian device that hears of it will
 * not approve or release.
 */
export async function cancelRequest(
  ports: DeskPorts,
  circleId: string,
  requestPacket: string,
): Promise<Cancelled> {
  const record = await owned(ports, circleId);
  const decoded = decodePacket(requestPacket);
  if (decoded.kind !== "request") {
    throw new DeskError("kind", `this is a ${decoded.kind}, not a request`);
  }
  const request = checkRequest(decoded.value, record.signedPolicy);
  const digest = requestDigest(request);
  const cancellation = signCancellation({
    circleId,
    requestDigest: digest,
    ownerSecretKey: record.ownerSecretKey,
    now: ports.now(),
  });
  const ask = await load(ports.pending, KEYS.ask(digest), AskSchema);
  if (ask) {
    const ledger = ledgerOf(ports, ask, record);
    ledger.cancel(cancellation);
    await save(ports.pending, KEYS.ask(digest), AskSchema, {
      ...ask,
      snapshot: plainSnapshot(ledger.snapshot()),
    });
  }
  return {
    digest,
    packet: encodePacket({ kind: "cancellation", value: cancellation }),
  };
}

/** Forget the circle. Guardians keep what they hold; tell them, for it can no longer be changed. */
export async function retireCircle(
  ports: DeskPorts,
  circleId: string,
): Promise<void> {
  await owned(ports, circleId);
  await ports.records.removeOwned(circleId);
  await ports.pending.remove(KEYS.receipts(circleId));
  await ports.pending.remove(KEYS.draft(circleId));
  await forgetDealt(ports, circleId);
  for (const key of await ports.pending.list("ask:")) {
    const ask = await load(ports.pending, key, AskSchema);
    if (ask?.circleId === circleId) await ports.pending.remove(key);
  }
}
