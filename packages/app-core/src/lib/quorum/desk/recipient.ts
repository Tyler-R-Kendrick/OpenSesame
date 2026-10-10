/**
 * The recipient's side of a recovery (ADR 0186 §10): open the recovery file,
 * raise a request with a fresh key of their own, gather the guardians'
 * approvals and then their releases, and open what the circle protected.
 *
 * The ledger here is the recipient's own. It keeps the packets in order and
 * the clocks honest for the person using it, but it is not what stops a
 * recovery: each guardian's device verifies the quorum before it releases.
 */

import { toB64url, wipe } from "../bytes.js";
import type { Json } from "../canonical.js";
import { type RecoveryBundle, RecoveryBundleSchema } from "../circle.js";
import type { LedgerStatus, Outcome } from "../ledger-types.js";
import { QuorumLedger } from "../ledger.js";
import { decodePacket, encodePacket } from "../packets.js";
import { verifySignedPolicy } from "../policy.js";
import { ruleText } from "../records.js";
import { completeRecovery, startRecovery } from "../recover.js";
import type { SignedPolicy } from "../types.js";
import {
  KEYS,
  type Recovery,
  RecoverySchema,
  keyBytes,
  load,
  plainSnapshot,
  save,
} from "./docs.js";
import { DeskError, type DeskPorts } from "./ports.js";
import { type Progress, progressToward } from "./recovery-progress.js";

export type BundleView = Readonly<{
  label: string;
  collection: string;
  rule: string;
  epoch: number;
  guardians: readonly string[];
  signedPolicy: SignedPolicy;
}>;

function parseBundle(text: string): RecoveryBundle {
  try {
    return RecoveryBundleSchema.parse(JSON.parse(text));
  } catch {
    throw new DeskError("bundle", "this is not a recovery file");
  }
}

/** What a recovery file is, from the owner's signed policy inside it. */
export function readBundle(text: string): BundleView {
  const bundle = parseBundle(text);
  const signedPolicy = verifySignedPolicy(bundle.signedPolicy);
  const { policy } = signedPolicy;
  return {
    label: policy.label,
    collection: policy.collection,
    rule: ruleText(policy),
    epoch: policy.epoch,
    guardians: policy.guardians.map((g) => g.name),
    signedPolicy,
  };
}

export type RecoveryView = Readonly<{
  requestId: string;
  label: string;
  /** The request as one line of text for the guardians. */
  request: string;
  status: LedgerStatus;
  approvedBy: readonly string[];
  releasedBy: readonly string[];
  /** Names, to say whom to ask. */
  names: Readonly<Record<string, string>>;
  /** How far approvals and releases have got against what the circle's rule asks for. */
  progress: Readonly<{ approvals: Progress; releases: Progress }>;
}>;

function ledgerOf(ports: DeskPorts, doc: Recovery): QuorumLedger {
  const ledger = QuorumLedger.open(doc.bundle.signedPolicy, doc.request, () =>
    ports.now().getTime(),
  );
  ledger.restore(doc.snapshot);
  return ledger;
}

function viewOf(doc: Recovery, ledger: QuorumLedger): RecoveryView {
  const { policy } = doc.bundle.signedPolicy;
  const approvedBy = ledger.approvedGuardians();
  const releasedBy = ledger.releases().map((r) => r.guardianId);
  return {
    requestId: doc.request.requestId,
    label: policy.label,
    request: encodePacket({ kind: "request", value: doc.request }),
    status: ledger.status(),
    approvedBy,
    releasedBy,
    names: Object.fromEntries(policy.guardians.map((g) => [g.id, g.name])),
    progress: {
      approvals: progressToward(policy, approvedBy),
      releases: progressToward(policy, releasedBy),
    },
  };
}

async function recoveryOf(
  ports: DeskPorts,
  requestId: string,
): Promise<Recovery> {
  const doc = await load(
    ports.pending,
    KEYS.recovery(requestId),
    RecoverySchema,
  );
  if (!doc) throw new DeskError("no_recovery", "no such recovery");
  return doc;
}

/** Raise a request to recover what a circle protects, to a key made now on this device. */
export async function startRecoveryFlow(
  ports: DeskPorts,
  input: { bundleText: string; recipientLabel: string },
): Promise<RecoveryView> {
  const bundle = parseBundle(input.bundleText);
  const signedPolicy = verifySignedPolicy(bundle.signedPolicy);
  const started = startRecovery({
    signedPolicy,
    recipientLabel: input.recipientLabel,
    now: ports.now(),
  });
  const doc: Recovery = {
    v: 1,
    bundle,
    request: started.request,
    recipientSecretKey: toB64url(started.recipient.secretKey),
    snapshot: plainSnapshot(
      QuorumLedger.open(signedPolicy, started.request, () =>
        ports.now().getTime(),
      ).snapshot(),
    ),
  };
  wipe(started.recipient.secretKey);
  await save(
    ports.pending,
    KEYS.recovery(doc.request.requestId),
    RecoverySchema,
    doc,
  );
  return viewOf(doc, ledgerOf(ports, doc));
}

export async function recoveryStatus(
  ports: DeskPorts,
  requestId: string,
): Promise<RecoveryView> {
  const doc = await recoveryOf(ports, requestId);
  return viewOf(doc, ledgerOf(ports, doc));
}

export async function listRecoveries(
  ports: DeskPorts,
): Promise<readonly RecoveryView[]> {
  const views: RecoveryView[] = [];
  for (const key of await ports.pending.list("recovery:")) {
    const doc = await load(ports.pending, key, RecoverySchema);
    if (doc) views.push(viewOf(doc, ledgerOf(ports, doc)));
  }
  return views;
}

export type Ingested = Readonly<{
  outcomes: readonly Outcome[];
  view: RecoveryView;
}>;

/** Approvals, then releases, as guardians send them. Each is checked by the ledger; a refusal says why. */
export async function ingest(
  ports: DeskPorts,
  requestId: string,
  packet: string,
): Promise<Ingested> {
  const doc = await recoveryOf(ports, requestId);
  const ledger = ledgerOf(ports, doc);
  const decoded = decodePacket(packet);
  const outcomes: Outcome[] = [];
  if (decoded.kind === "approval") {
    outcomes.push(await ledger.submitApproval(decoded.value));
  } else if (decoded.kind === "approvals") {
    for (const approval of decoded.value) {
      outcomes.push(await ledger.submitApproval(approval));
    }
  } else if (decoded.kind === "release") {
    outcomes.push(await ledger.submitRelease(decoded.value));
  } else {
    throw new DeskError(
      "kind",
      `this is a ${decoded.kind}, not an approval or a release`,
    );
  }
  await save(ports.pending, KEYS.recovery(requestId), RecoverySchema, {
    ...doc,
    snapshot: plainSnapshot(ledger.snapshot()),
  });
  return { outcomes, view: viewOf(doc, ledger) };
}

/** The approvals so far as one packet, for the guardians who will release. */
export async function approvalsPacket(
  ports: DeskPorts,
  requestId: string,
): Promise<string> {
  const doc = await recoveryOf(ports, requestId);
  const approvals = ledgerOf(ports, doc).approvalList();
  if (approvals.length === 0) {
    throw new DeskError("no_approvals", "no one has approved yet");
  }
  return encodePacket({ kind: "approvals", value: approvals });
}

/**
 * Recombine the released shares and return the protected document. Opening
 * does not end the recovery: the recovery stays, with the key this device made
 * for it, so that a document that was not saved yet, or a page that was
 * reloaded, does not lose the only way back to it. Open it again and the same
 * document comes back; end it with `finishRecovery` once the document is safe.
 *
 * On `RecoveryError` a damaged release has been dropped and the recovery stays
 * for another try, as it does after a success.
 */
export async function openRecovery(
  ports: DeskPorts,
  requestId: string,
): Promise<Json> {
  const doc = await recoveryOf(ports, requestId);
  const ledger = ledgerOf(ports, doc);
  const recipientSecretKey = keyBytes(doc.recipientSecretKey);
  try {
    return await completeRecovery({
      ledger,
      recipientSecretKey,
      bundle: doc.bundle,
    });
  } catch (error) {
    // A damaged release was dropped from the ledger so its guardian can send
    // another; keep that, or the next try would meet the same bad packet.
    await save(ports.pending, KEYS.recovery(requestId), RecoverySchema, {
      ...doc,
      snapshot: plainSnapshot(ledger.snapshot()),
    });
    throw error;
  } finally {
    wipe(recipientSecretKey);
  }
}

/**
 * End a recovery whose document is safe — saved to a file, or in the vault.
 * Its key is removed from this device, and opening it again is refused.
 */
export async function finishRecovery(
  ports: DeskPorts,
  requestId: string,
): Promise<void> {
  await ports.pending.remove(KEYS.recovery(requestId));
}

/** Give up on a recovery: its key is removed. */
export async function abandonRecovery(
  ports: DeskPorts,
  requestId: string,
): Promise<void> {
  await ports.pending.remove(KEYS.recovery(requestId));
}
