/**
 * Scenario 3: hostile pastes. Every field of these screens takes text from
 * outside, so each is shown a packet of the wrong kind, a packet cut short, and
 * a packet of the right kind that this step has no business with. The first
 * two are read as they are pasted: a mark on the field, its key off, nothing
 * begun. The third is refused when its key is pressed: a mark on the control,
 * a notice in the tray, and the list it was meant for unchanged.
 */

import { expect } from "./tc-expect.mjs";
import { ACCEPT, TAKE, openSheet } from "./tc-guardian.mjs";
import { nameCircle, openNewCircle } from "./tc-owner.mjs";
import { startFrom } from "./tc-recovery.mjs";
import { expectLiveRefusal, expectRefusal } from "./tc-refusals.mjs";

/** The first half of a packet: what a lost line leaves behind. */
const cutShort = (packet) => packet.slice(0, Math.floor(packet.length / 2));

/** The middle of a packet gone and its check kept: what a mail client's line wrapping can leave behind. */
const elided = (packet) => `${packet.slice(0, 60)}${packet.slice(-30)}`;

/** The owner's "A contact's answer" is shown an invitation, and an enrollment that answers another one. */
async function ownerPeopleField(ctx, state) {
  const { owner } = ctx.cast;
  const sheet = await openNewCircle(owner);
  const invite = await nameCircle(owner, sheet, "Strangers");
  const field = "A contact's answer";
  const people = sheet.getByRole("list", { name: "Contacts" });
  await owner.paste(field, invite, sheet);
  await expectLiveRefusal(owner, {
    field,
    key: "Add this contact",
    mark: /^This is an invite, not an enrollment\.$/,
    scope: sheet,
  });
  await owner.paste(field, elided(state.circle.enrollments.get("Ada")), sheet);
  await expectLiveRefusal(owner, {
    field,
    key: "Add this contact",
    mark: /^This packet was cut off or changed on the way\.$/,
    scope: sheet,
  });
  await owner.paste(
    field,
    cutShort(state.circle.enrollments.get("Ada")),
    sheet,
  );
  await expectLiveRefusal(owner, {
    field,
    key: "Add this contact",
    mark: /^This is not a packet\.$/,
    scope: sheet,
  });
  // Right kind, wrong invitation: Ada answered Family's, not this one.
  await owner.paste(field, state.circle.enrollments.get("Ada"), sheet);
  await owner.press("Add this contact", sheet);
  await expectRefusal(owner, { scope: sheet.locator(".tc-packet-in") });
  await expect(people).toHaveCount(0);
  await owner.snap("hostile-answer");
  await owner.closeSheet("Start a circle");
  return invite;
}

/** A guardian's invitation field is shown an enrollment and a half an invitation. */
async function guardianInvitationField(ctx, state, invite) {
  const { ada } = ctx.cast;
  const sheet = await openSheet(ada, ACCEPT);
  const field = "An invitation";
  await ada.paste(field, state.circle.enrollments.get("Ada"), sheet);
  await expectLiveRefusal(ada, {
    field,
    key: "Read this invitation",
    mark: /^This is an enrollment, not an invite\.$/,
    scope: sheet,
  });
  await ada.paste(field, elided(invite), sheet);
  await expectLiveRefusal(ada, {
    field,
    key: "Read this invitation",
    mark: /^This packet was cut off or changed on the way\.$/,
    scope: sheet,
  });
  await ada.paste(field, "not a packet at all", sheet);
  await expectLiveRefusal(ada, {
    field,
    key: "Read this invitation",
    mark: /^This is not a packet\.$/,
    scope: sheet,
  });
  await ada.snap("hostile-invitation");
  await ada.closeSheet(ACCEPT);
}

/** Taking what an owner sent: an invitation is not that, and someone else's welcome is not mine. */
async function guardianTakeField(ctx, state, invite) {
  const { bo } = ctx.cast;
  const sheet = await openSheet(bo, TAKE);
  const field = "What an owner sent";
  await bo.paste(field, invite, sheet);
  await expectLiveRefusal(bo, {
    field,
    key: "Take what was sent",
    mark: /^This is an invite, not a welcome or a policy\.$/,
    scope: sheet,
  });
  await bo.paste(field, state.circle.packets.get("Ada"), sheet);
  await bo.press("Take what was sent", sheet);
  await expectRefusal(bo, { scope: sheet.locator(".tc-packet-in") });
  await bo.closeSheet(TAKE);
}

/** The recipient's answer field is shown a request, and an approval that was made for another request. */
async function recipientAnswerField(ctx, state) {
  const { recipient } = ctx.cast;
  const second = await startFrom(recipient, state.circle.file, "Second laptop");
  const field = "An approval or a release";
  await recipient.paste(field, second.request, second.sheet);
  await expectLiveRefusal(recipient, {
    field,
    key: "Add",
    mark: /^This is a request, not an approval, an approvals list or a release\.$/,
    scope: second.sheet,
  });
  await recipient.paste(field, "osq1.approval.AAAA", second.sheet);
  await expectLiveRefusal(recipient, {
    field,
    key: "Add",

    scope: second.sheet,
  });
  // The first recovery's approval, for the first recovery's request.
  await recipient.paste(field, state.approvals[0], second.sheet);
  await recipient.press("Add", second.sheet);
  await expectRefusal(recipient, { scope: second.sheet });
  await expect(second.sheet.locator(".found__name").first()).toHaveText(
    "0 of 2 approved",
  );
  await recipient.snap("hostile-approval");
  // The sheet is closed (the tray is read), and the recovery stays: a row to open again.
  await recipient.closeSheet("Family recovery");
  return { request: second.request };
}

/** Scenario 3. Leaves a second recovery gathering approvals, for the scenarios after it. */
export async function hostilePastes(ctx, state) {
  const invite = await ownerPeopleField(ctx, state);
  await guardianInvitationField(ctx, state, invite);
  await guardianTakeField(ctx, state, invite);
  state.second = await recipientAnswerField(ctx, state);
}
