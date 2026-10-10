/**
 * The invitations a guardian has agreed to and not yet been answered (ADR 0186
 * §10). Agreeing keeps a receiving key and the invitation in the pending store
 * until the owner's welcome arrives; until then nothing in the list of circles
 * held says the agreement exists, so a screen lists these beside it, and lets
 * the person forget one they no longer want.
 *
 * A listed agreement carries only what two people can talk about: which
 * circle, and the owner's key as the short name they can check by voice. The
 * receiving key stays in the pending store.
 */

import { keyFingerprint } from "../request.js";
import { GuardianPendingSchema, KEYS, load } from "./docs.js";
import { DeskError, type DeskPorts } from "./ports.js";

const PREFIX = "guardian-pending:";

/** An invitation this device agreed to, waiting for what the owner sends. */
export type Agreement = Readonly<{
  inviteId: string;
  circleId: string;
  circleLabel: string;
  /** The owner key as a short name to check by another road. */
  ownerFingerprint: string;
}>;

export async function listAgreements(
  ports: DeskPorts,
): Promise<readonly Agreement[]> {
  const agreements: Agreement[] = [];
  for (const key of await ports.pending.list(PREFIX)) {
    const doc = await load(ports.pending, key, GuardianPendingSchema);
    if (!doc) continue;
    agreements.push({
      inviteId: doc.invite.inviteId,
      circleId: doc.invite.circleId,
      circleLabel: doc.invite.label,
      ownerFingerprint: keyFingerprint(doc.invite.ownerKey),
    });
  }
  return agreements;
}

/**
 * Forget an agreement: the receiving key goes with it, and a welcome the owner
 * sends for it is then refused. The owner is not told by this.
 */
export async function forgetAgreement(
  ports: DeskPorts,
  inviteId: string,
): Promise<void> {
  const key = KEYS.guardian(inviteId);
  if (!(await load(ports.pending, key, GuardianPendingSchema))) {
    throw new DeskError(
      "no_agreement",
      "this device has not accepted that invitation",
    );
  }
  await ports.pending.remove(key);
}

/**
 * Once a welcome is taken for a circle, no agreement made for it is waiting
 * any more, including a second one made from a later invitation to the same
 * circle. A document that no longer reads is left alone: it is not this
 * step's to judge, and the list will say so.
 */
export async function settleAgreements(
  ports: DeskPorts,
  circleId: string,
): Promise<void> {
  for (const key of await ports.pending.list(PREFIX)) {
    const found = GuardianPendingSchema.safeParse(
      await ports.pending.read(key),
    );
    if (found.success && found.data.invite.circleId === circleId) {
      await ports.pending.remove(key);
    }
  }
}
