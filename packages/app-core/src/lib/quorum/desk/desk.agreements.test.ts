/**
 * The invitations a guardian has agreed to and not yet been answered: listed
 * without a secret, gone once the welcome is taken, and forgettable.
 */
import { describe, expect, it } from "vitest";
import { expectPacket } from "../packets.js";
import { keyFingerprint } from "../request.js";
import { PAYLOAD } from "../world.test-support.js";
import { GuardianPendingSchema } from "./docs.js";
import { Clock, device, oneGroup } from "./harness.test-support.js";
import {
  DEFAULT_TIMING,
  acceptGuardian,
  acceptInvitation,
  beginCircle,
  createFromDraft,
  forgetAgreement,
  listAgreements,
  takeWelcome,
} from "./index.js";

/** Three people agree; the owner deals. Ada's device holds an agreement and the welcome meant for it. */
async function agreed() {
  const clock = new Clock();
  const owner = device(clock);
  const { draft, invite } = await beginCircle(owner, {
    label: "Family",
    collection: "Emergency",
    recovers: true,
  });
  const people = new Map(
    ["Ada", "Ben", "Cy"].map((name) => [name, device(clock)]),
  );
  const ids: string[] = [];
  for (const [name, person] of people) {
    const { enrollment } = await acceptInvitation(person, {
      packet: invite,
      name,
      keyLabels: ["Security key"],
    });
    const guardian = await acceptGuardian(owner, draft.circleId, {
      packet: enrollment,
      custodyDomain: `home-${name}`,
      contactRef: null,
    });
    ids.push(guardian.id);
  }
  const dealt = await createFromDraft(owner, draft.circleId, {
    rule: oneGroup(ids, 2),
    timing: DEFAULT_TIMING,
    payload: PAYLOAD,
  });
  const ada = people.get("Ada");
  const welcome = dealt.welcomes.find((one) => one.name === "Ada");
  if (!ada || !welcome) throw new Error("no welcome for Ada");
  return { clock, owner, invite, ada, welcome: welcome.packet };
}

/** The receiving key the desk sealed for an agreement: the one thing a listing must not carry. */
async function secretOf(person: ReturnType<typeof device>) {
  const [key] = await person.pending.list("guardian-pending:");
  const text = JSON.stringify(await person.pending.read(key ?? ""));
  const secret = /"hpkeSecretKey":"([^"]+)"/.exec(text)?.[1];
  if (!secret) throw new Error("no receiving key kept");
  return { key: key ?? "", secret, text };
}

describe("the invitations a guardian has agreed to", () => {
  it("lists nothing until one is agreed to, then the circle and the owner's key, and no secret", async () => {
    const clock = new Clock();
    const owner = device(clock);
    const { invite } = await beginCircle(owner, {
      label: "Family",
      collection: "Emergency",
      recovers: true,
    });
    const ada = device(clock);
    expect(await listAgreements(ada)).toEqual([]);

    await acceptInvitation(ada, {
      packet: invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    const { value } = expectPacket(invite, "invite");
    const listed = await listAgreements(ada);
    expect(listed).toEqual([
      {
        inviteId: value.inviteId,
        circleId: value.circleId,
        circleLabel: "Family",
        ownerFingerprint: keyFingerprint(value.ownerKey),
      },
    ]);
    const { secret } = await secretOf(ada);
    expect(secret.length).toBeGreaterThan(20);
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(JSON.stringify(listed)).not.toContain("Ada");
  });

  it("has none left once the welcome is taken, and holds the circle instead", async () => {
    const { ada, welcome } = await agreed();
    expect(await listAgreements(ada)).toHaveLength(1);
    await takeWelcome(ada, welcome);
    expect(await listAgreements(ada)).toEqual([]);
    expect(await ada.records.held()).toHaveLength(1);
  });

  it("settles every agreement made for the circle when its welcome is taken, and no other", async () => {
    const { ada, welcome, clock } = await agreed();
    // A second agreement for the same circle, from a later invitation, and one for another circle.
    const { key, text } = await secretOf(ada);
    const doc = GuardianPendingSchema.parse(JSON.parse(text));
    await ada.pending.write("guardian-pending:second", {
      ...doc,
      invite: { ...doc.invite, inviteId: "second" },
    });
    const elsewhere = await beginCircle(device(clock), {
      label: "Work",
      collection: "Logins",
      recovers: false,
    });
    await acceptInvitation(ada, {
      packet: elsewhere.invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    expect(await ada.pending.list("guardian-pending:")).toHaveLength(3);

    await takeWelcome(ada, welcome);
    const left = await listAgreements(ada);
    expect(left.map((one) => one.circleLabel)).toEqual(["Work"]);
    expect(await ada.pending.read(key)).toBeUndefined();
  });

  it("forgets one, which refuses the welcome it was waiting for, and says so when it is already gone", async () => {
    const { ada, welcome } = await agreed();
    const [agreement] = await listAgreements(ada);
    if (!agreement) throw new Error("no agreement");
    await forgetAgreement(ada, agreement.inviteId);
    expect(await listAgreements(ada)).toEqual([]);
    expect(await ada.pending.list("guardian-pending:")).toEqual([]);
    await expect(takeWelcome(ada, welcome)).rejects.toMatchObject({
      code: "no_invitation",
    });
    await expect(
      forgetAgreement(ada, agreement.inviteId),
    ).rejects.toMatchObject({ code: "no_agreement" });
  });

  it("forgets only the one it is told to", async () => {
    const { ada, clock } = await agreed();
    const other = await beginCircle(device(clock), {
      label: "Work",
      collection: "Logins",
      recovers: false,
    });
    await acceptInvitation(ada, {
      packet: other.invite,
      name: "Ada",
      keyLabels: ["Security key"],
    });
    const listed = await listAgreements(ada);
    const family = listed.find((one) => one.circleLabel === "Family");
    if (!family) throw new Error("no Family");
    await forgetAgreement(ada, family.inviteId);
    expect((await listAgreements(ada)).map((one) => one.circleLabel)).toEqual([
      "Work",
    ]);
  });

  it("refuses to list through a stored value that no longer reads, rather than hiding it", async () => {
    const clock = new Clock();
    const ada = device(clock);
    await ada.pending.write("guardian-pending:broken", {
      v: 1,
      nonsense: true,
    });
    await expect(listAgreements(ada)).rejects.toMatchObject({ code: "stored" });
  });
});
