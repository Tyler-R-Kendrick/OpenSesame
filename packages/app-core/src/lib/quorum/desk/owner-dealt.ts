/**
 * What an owner hands out once a circle is made or changed, kept until it has
 * been taken (ADR 0186 §10, ADR 0149).
 *
 * A circle's shares exist only at the moment it is made: nothing here can deal
 * them again, so a screen that is closed before every contact has their packet
 * would strand people. The packets are public by construction (the signed
 * policy, and a share sealed to each guardian's own receiving key), and the
 * recovery file is the payload under a key only a quorum of the shares can
 * rebuild. They rest in the sealed pending store like every other ceremony in
 * flight, and are removed when they have done their work:
 *
 * - a circle that holds shares is armed when every contact's receipt is in;
 * - a circle of approvals only has no receipt to wait for, so its packets stay
 *   until the circle is changed or retired;
 * - a new epoch, or a retired circle, supersedes them.
 *
 * Keeping is best-effort. A circle that was made must not look as if it were
 * not because a document was too large to keep, so a failure to keep is
 * reported in `Dealt.kept` and the packets are still handed back to the screen
 * that made them.
 */

import { z } from "zod";
import { RecoveryBundleSchema } from "../circle.js";
import { expectPacket } from "../packets.js";
import { policyWarnings } from "../policy.js";
import { KEYS, load, save } from "./docs.js";
import type { Dealt, Handout } from "./owner-shared.js";
import { DeskError, type DeskPorts } from "./ports.js";

/** A packet is at most 128 KiB decoded; as text a third more. */
const PACKET_TEXT_MAX = 256 * 1024;
/** The pending store refuses anything past 16 MiB; the file leaves room for the rest. */
const BUNDLE_TEXT_MAX = 15 * 1024 * 1024;

function isPacket(kind: "welcome" | "policy") {
  return (text: string): boolean => {
    try {
      expectPacket(text, kind);
      return true;
    } catch {
      return false;
    }
  };
}

function isBundle(text: string): boolean {
  try {
    return RecoveryBundleSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/** Each welcome is for this circle and this epoch, as its own signed policy says. */
function namesItself(doc: {
  circleId: string;
  epoch: number;
  welcomes: readonly { packet: string }[];
}): boolean {
  try {
    return doc.welcomes.every((handout) => {
      const { policy } = expectPacket(handout.packet, "welcome").value
        .signedPolicy;
      return policy.circleId === doc.circleId && policy.epoch === doc.epoch;
    });
  } catch {
    // A packet that does not read has already been refused on its own field.
    return false;
  }
}

const GuardianName = z.string().min(1).max(120);
const GuardianId = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

const WelcomeHandout = z
  .object({
    guardianId: GuardianId,
    name: GuardianName,
    packet: z.string().max(PACKET_TEXT_MAX).refine(isPacket("welcome")),
  })
  .strict();

const NoticeHandout = z
  .object({
    guardianId: GuardianId,
    name: GuardianName,
    packet: z.string().max(PACKET_TEXT_MAX).refine(isPacket("policy")),
  })
  .strict();

export const DealtDocSchema = z
  .object({
    v: z.literal(1),
    circleId: z.string(),
    /** The epoch these were dealt for: a newer one supersedes them. */
    epoch: z.number().int().min(1),
    welcomes: z.array(WelcomeHandout).min(1).max(32),
    notices: z.array(NoticeHandout).max(32),
    bundleFile: z.string().max(BUNDLE_TEXT_MAX).refine(isBundle).nullable(),
  })
  .strict()
  .refine(namesItself);
export type DealtDoc = z.infer<typeof DealtDocSchema>;

const handout = (h: Handout) => ({
  guardianId: h.guardianId,
  name: h.name,
  packet: h.packet,
});

/**
 * Keep what was just dealt for `epoch`. Says whether it was kept; a circle
 * that was made is made either way, and what could not be kept is not left
 * behind from an earlier epoch to be mistaken for this one.
 */
export async function keepDealt(
  ports: DeskPorts,
  made: Dealt,
  epoch: number,
): Promise<boolean> {
  try {
    await save(ports.pending, KEYS.dealt(made.circleId), DealtDocSchema, {
      v: 1,
      circleId: made.circleId,
      epoch,
      welcomes: made.welcomes.map(handout),
      notices: made.notices.map(handout),
      bundleFile: made.bundleFile,
    });
    return true;
  } catch {
    await ports.pending.remove(KEYS.dealt(made.circleId)).catch(() => {
      // Nothing was kept, and nothing could be taken away either.
    });
    return false;
  }
}

/** Let go of what was dealt: it has been taken, or the circle has moved on. */
export async function forgetDealt(
  ports: DeskPorts,
  circleId: string,
): Promise<void> {
  await ports.pending.remove(KEYS.dealt(circleId));
}

/**
 * The packets still to be handed out for a circle, or `null` when there are
 * none: nothing was kept, they were all taken, or the circle has moved on to a
 * newer epoch or is gone. A kept document that does not read, or that names a
 * circle or epoch other than its own, is not used and is removed.
 */
export async function readDealt(
  ports: DeskPorts,
  circleId: string,
): Promise<Dealt | null> {
  const key = KEYS.dealt(circleId);
  let doc: DealtDoc | null;
  try {
    doc = await load(ports.pending, key, DealtDocSchema);
  } catch (error) {
    if (error instanceof DeskError && error.code === "stored") {
      await ports.pending.remove(key);
      return null;
    }
    throw error;
  }
  if (!doc || doc.circleId !== circleId) {
    if (doc) await ports.pending.remove(key);
    return null;
  }
  const record = (await ports.records.owned()).find(
    (r) => r.signedPolicy.policy.circleId === circleId,
  );
  const current = record?.signedPolicy.policy.epoch === doc.epoch;
  // A circle that holds shares is done with its packets once it is armed.
  const taken = doc.bundleFile !== null && record?.state === "armed";
  if (!record || !current || taken) {
    await ports.pending.remove(key);
    return null;
  }
  return {
    circleId,
    welcomes: doc.welcomes,
    notices: doc.notices,
    bundleFile: doc.bundleFile,
    warnings: policyWarnings(record.signedPolicy.policy),
    kept: true,
  };
}
