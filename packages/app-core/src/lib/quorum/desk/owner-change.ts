import type { Json } from "../canonical.js";
import { reissueCircle } from "../epoch.js";
import { verifyCustodyReceipt } from "../guardian.js";
import { expectPacket } from "../packets.js";
import type { SignedPolicy } from "../types.js";
import { KEYS, OwnerDraftSchema, ReceiptsSchema, load, save } from "./docs.js";
import {
  type Dealt,
  type RuleInput,
  type TimingInput,
  circleDraftOf,
  dealt,
  ownedRecord,
  stateAfter,
} from "./owner-shared.js";
import type { DeskPorts } from "./ports.js";

export type CustodyStatus = Readonly<{
  /** Guardians whose key has reopened their share, by id. */
  held: readonly string[];
  total: number;
  armed: boolean;
}>;

async function custodyOf(
  ports: DeskPorts,
  signed: SignedPolicy,
): Promise<readonly string[]> {
  const receipts = await load(
    ports.pending,
    KEYS.receipts(signed.policy.circleId),
    ReceiptsSchema,
  );
  return receipts && receipts.epoch === signed.policy.epoch
    ? receipts.guardianIds
    : [];
}

export async function custodyStatus(
  ports: DeskPorts,
  circleId: string,
): Promise<CustodyStatus> {
  const record = await ownedRecord(ports, circleId);
  const held = await custodyOf(ports, record.signedPolicy);
  return {
    held,
    total: record.signedPolicy.policy.guardians.length,
    armed: record.state === "armed",
  };
}

/** A guardian's custody receipt: proof their key reopened the share. Arms the circle when all are in. */
export async function recordReceipt(
  ports: DeskPorts,
  circleId: string,
  packet: string,
): Promise<CustodyStatus> {
  const record = await ownedRecord(ports, circleId);
  const receipt = await verifyCustodyReceipt(
    record.signedPolicy,
    expectPacket(packet, "receipt").value,
  );
  const held = new Set(await custodyOf(ports, record.signedPolicy));
  held.add(receipt.guardianId);
  const { policy } = record.signedPolicy;
  await save(ports.pending, KEYS.receipts(circleId), ReceiptsSchema, {
    epoch: policy.epoch,
    guardianIds: [...held],
  });
  const armed = policy.guardians.every((g) => held.has(g.id));
  if (armed && record.state === "inviting") {
    await ports.records.saveOwned({ ...record, state: "armed" });
  }
  return { held: [...held], total: policy.guardians.length, armed };
}

/**
 * The next epoch: drop some guardians, add the people invited since, set the
 * rule, and deal everyone who stays or joins a new share. The old recovery
 * file is useless for the new epoch's shares; save the new one.
 */
export async function reissue(
  ports: DeskPorts,
  circleId: string,
  input: {
    drop: readonly string[];
    rule: RuleInput;
    timing?: TimingInput;
    payload?: Json;
  },
): Promise<Dealt> {
  const record = await ownedRecord(ports, circleId);
  const { policy } = record.signedPolicy;
  const draft = await load(
    ports.pending,
    KEYS.draft(circleId),
    OwnerDraftSchema,
  );
  const retired = policy.guardians.filter((g) => input.drop.includes(g.id));
  const roster = [
    ...policy.guardians.filter((g) => !input.drop.includes(g.id)),
    ...(draft?.guardians ?? []),
  ];
  const timing = input.timing ?? {
    approvalWindowSec: policy.approvalWindowSec,
    releaseDelaySec: policy.releaseDelaySec,
    requestLifetimeSec: policy.requestLifetimeSec,
    requireUserVerification: policy.requireUserVerification,
  };
  const next = circleDraftOf(
    policy,
    policy.operations.includes("recover-collection"),
    roster,
    input.rule,
    timing,
  );
  const reissued = await reissueCircle({
    previous: record.signedPolicy,
    owner: {
      publicKey: policy.ownerKey,
      secretKey: record.ownerSecretKey,
    },
    draft: next,
    payload: input.payload,
    now: ports.now(),
  });
  await ports.records.saveOwned({
    signedPolicy: reissued.signedPolicy,
    ownerSecretKey: record.ownerSecretKey,
    state: stateAfter(reissued),
  });
  await save(ports.pending, KEYS.receipts(circleId), ReceiptsSchema, {
    epoch: reissued.signedPolicy.policy.epoch,
    guardianIds: [],
  });
  await ports.pending.remove(KEYS.draft(circleId));
  return dealt(reissued, roster, retired);
}
