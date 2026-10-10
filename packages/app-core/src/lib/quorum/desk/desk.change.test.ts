/**
 * Changing a circle through the desk: a guardian replaced, shares refreshed,
 * and the people who are no longer in it told. Then the same circle recovers
 * at the new epoch.
 */
import { describe, expect, it } from "vitest";
import { PAYLOAD } from "../world.test-support.js";
import {
  Clock,
  armedCircle,
  device,
  oneGroup,
  who,
} from "./harness.test-support.js";
import {
  acceptGuardian,
  acceptInvitation,
  applyNotice,
  approvalsPacket,
  approveRequest,
  custodyStatus,
  ingest,
  inviteMore,
  openRecovery,
  recordReceipt,
  reissue,
  releaseShare,
  startRecoveryFlow,
  takeWelcome,
} from "./index.js";

/** Cy is out, Dee is in: invite her, take her enrollment, reissue. */
async function replaceCy(clock: Clock) {
  const armed = await armedCircle(clock);
  const dee = device(clock);
  const { invite } = await inviteMore(armed.owner, armed.circleId);
  const { enrollment } = await acceptInvitation(dee, {
    packet: invite,
    name: "Dee",
    keyLabels: ["Security key"],
  });
  const guardian = await acceptGuardian(armed.owner, armed.circleId, {
    packet: enrollment,
    custodyDomain: "home-Dee",
    contactRef: null,
  });
  const [ada, ben, cy] = armed.guardianIds;
  if (!ada || !ben || !cy) throw new Error("no guardians");
  clock.at(3600);
  const dealt = await reissue(armed.owner, armed.circleId, {
    drop: [cy],
    rule: oneGroup([ada, ben, guardian.id], 2),
    payload: PAYLOAD,
  });
  return { armed, dee, dealt, cy };
}

describe("replacing a guardian through the desk", () => {
  it("deals the stayers and the newcomer a new share and tells the one who left", async () => {
    const clock = new Clock();
    const { armed, dee, dealt } = await replaceCy(clock);
    expect(dealt.welcomes.map((w) => w.name).sort()).toEqual([
      "Ada",
      "Ben",
      "Dee",
    ]);
    expect(dealt.notices.map((w) => w.name)).toEqual(["Cy"]);

    // Cy learns they are out, and their share is dropped.
    const cyNotice = dealt.notices[0];
    if (!cyNotice) throw new Error("no notice");
    expect(await applyNotice(who(armed, "Cy"), cyNotice.packet)).toBe(
      "retired",
    );
    expect(await who(armed, "Cy").records.held()).toEqual([]);

    // Ada hears of the new epoch first and waits for her share.
    expect(await applyNotice(who(armed, "Ada"), cyNotice.packet)).toBe(
      "awaiting_share",
    );

    for (const welcome of dealt.welcomes) {
      const holder = welcome.name === "Dee" ? dee : who(armed, welcome.name);
      const taken = await takeWelcome(holder, welcome.packet);
      expect(taken.epoch).toBe(2);
      await recordReceipt(armed.owner, armed.circleId, taken.receipt ?? "");
    }
    expect(await custodyStatus(armed.owner, armed.circleId)).toMatchObject({
      total: 3,
      armed: true,
    });
  });

  it("recovers at the new epoch with the newcomer, and not with the old bundle", async () => {
    const clock = new Clock();
    const { armed, dee, dealt } = await replaceCy(clock);
    for (const welcome of dealt.welcomes) {
      const holder = welcome.name === "Dee" ? dee : who(armed, welcome.name);
      await takeWelcome(holder, welcome.packet);
    }
    const recipient = device(clock);
    const started = await startRecoveryFlow(recipient, {
      bundleText: dealt.bundleFile ?? "",
      recipientLabel: "New laptop",
    });
    for (const holder of [who(armed, "Ada"), dee]) {
      await ingest(
        recipient,
        started.requestId,
        await approveRequest(holder, started.request),
      );
    }
    clock.at(3600 + 24 * 3600 + 1);
    const approvals = await approvalsPacket(recipient, started.requestId);
    for (const holder of [who(armed, "Ada"), dee]) {
      await ingest(
        recipient,
        started.requestId,
        await releaseShare(holder, { request: started.request, approvals }),
      );
    }
    expect(await openRecovery(recipient, started.requestId)).toEqual(PAYLOAD);
  });

  it("refuses to take the old epoch's share once the new one is held", async () => {
    const clock = new Clock();
    const { armed, dee, dealt } = await replaceCy(clock);
    for (const welcome of dealt.welcomes) {
      const holder = welcome.name === "Dee" ? dee : who(armed, welcome.name);
      await takeWelcome(holder, welcome.packet);
    }
    // The original welcome for Ada, replayed.
    const original = armed.dealt.welcomes.find((w) => w.name === "Ada");
    if (!original) throw new Error("no welcome");
    await expect(
      takeWelcome(who(armed, "Ada"), original.packet),
    ).rejects.toMatchObject({ code: "rollback" });
  });
});
