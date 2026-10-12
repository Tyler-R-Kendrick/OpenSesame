/**
 * Scenario 4: the security key says no. A virtual authenticator can stop
 * proving the user, be lost, or never do PRF, and each is read on the screens
 * where it bites: a guardian's Agree and Approve keys, the owner's Make the
 * circle. Each refusal is a mark and a notice, nothing is kept, and once the
 * key is as it should be the same step works.
 *
 * Cy is the guardian whose key is spent here (Cy leaves the circle in scenario
 * 7), and Di, who joins it there, is the one whose key first does no PRF.
 */

import { expect } from "./tc-expect.mjs";
import {
  ACCEPT,
  ANSWER,
  agree,
  openSheet,
  readInvitation,
  readRequest,
  takeWelcome,
} from "./tc-guardian.mjs";
import {
  addContact,
  addReceipt,
  copyPacketFor,
  makeCircle,
  nameCircle,
  openNewCircle,
  setClocks,
  setRule,
} from "./tc-owner.mjs";
import { addAnswer } from "./tc-recipient.mjs";
import { standing, startFrom } from "./tc-recovery.mjs";
import {
  expectLiveRefusal,
  expectNoticeCleared,
  expectRefusal,
} from "./tc-refusals.mjs";

const NOT_USED = /^The security key was not used\.$/;

/** Cy's key stops proving a PIN or biometric: Approve is refused, then works once, and counts once. */
async function approveWithoutVerification(ctx, state) {
  const { cy, recipient } = ctx.cast;
  const { request } = state.second;
  await cy.userVerified(false);
  const sheet = await openSheet(cy, ANSWER);
  await readRequest(cy, sheet, request);
  await expect(cy.mark("Open for approval", sheet)).toBeVisible();
  await cy.press("Approve", sheet);
  const sentence = await expectRefusal(cy, { mark: NOT_USED, scope: sheet });
  await expect(cy.key("Copy your approval", sheet)).toHaveCount(0);
  await cy.snap("key-not-verified");
  await cy.restoreKey();
  await cy.press("Approve", sheet);
  await expect(cy.key("Copy your approval", sheet)).toBeVisible();
  await expectNoticeCleared(cy, sentence);
  const approval = await cy.copy("your approval", sheet);
  await cy.closeSheet(ANSWER);
  await recipient.press("Open Family recovery");
  const gathering = recipient.sheet("Family recovery");
  await addAnswer(recipient, gathering, approval);
  await expect(standing(gathering)).toHaveText("1 of 2 approved");
  await recipient.closeSheet("Family recovery");
}

/** Cy loses the key: a new one is not the one Cy enrolled, and Approve is refused. */
async function approveWithLostKey(ctx, state) {
  const { cy, recipient } = ctx.cast;
  await cy.replaceKey();
  const third = await startFrom(recipient, state.circle.file, "Third laptop");
  const sheet = await openSheet(cy, ANSWER);
  await readRequest(cy, sheet, third.request);
  await cy.press("Approve", sheet);
  await expectRefusal(cy, { mark: NOT_USED, scope: sheet });
  await expect(cy.key("Copy your approval", sheet)).toHaveCount(0);
  await cy.closeSheet(ANSWER);
  // The request that no one can answer is let go: two presses, the second names what is lost.
  await recipient.press("Give up on this recovery", third.sheet);
  await recipient.press("Give up on this recovery for good", third.sheet);
  await expect(third.sheet).toHaveCount(0);
}

/** An invitation answered with the key the person carries; the sheet is closed after. */
async function answer(guardian, invite) {
  const sheet = await openSheet(guardian, ACCEPT);
  await readInvitation(guardian, sheet, invite);
  await agree(guardian, sheet, guardian.name);
  const enrollment = await guardian.copy("your answer", sheet);
  await guardian.closeSheet(ACCEPT);
  return enrollment;
}

/** Di answers with a key that will not prove the user: nothing is kept; a key that does is carried and it works. */
async function acceptWithoutVerification(di, invite) {
  const waiting = di
    .panel("guarding")
    .locator("li.tc-row", { hasText: "Strict" });
  await di.userVerified(false);
  const sheet = await openSheet(di, ACCEPT);
  await readInvitation(di, sheet, invite);
  await agree(di, sheet, "Di");
  await expectRefusal(di, { mark: NOT_USED, scope: sheet });
  await expect(di.key("Copy your answer", sheet)).toHaveCount(0);
  await di.closeSheet(ACCEPT);
  await expect(waiting, "a refused agreement is not kept").toHaveCount(0);
  await di.replaceKey({ prf: false });
  const enrollment = await answer(di, invite);
  await expect(waiting).toHaveCount(1);
  return enrollment;
}

/**
 * Di's key does no PRF: the desk judges the draft as the rule is set, and says so
 * on the rule. The way on is off, and nothing was begun, so there is no notice.
 */
async function refusedForNoPrf(owner, sheet) {
  await owner.press("Set the rule", sheet);
  const form = sheet.getByRole("form", { name: "Set the rule" });
  await expectLiveRefusal(owner, {
    key: "Set the clocks",
    mark: /^Di has no key that can protect a share/,
    scope: form,
  });
  await owner.snap("no-prf");
}

/** Di comes back with a key that does PRF: the old agreement is forgotten, the invitation answered again, the contact swapped. */
async function swapDi(ctx, { sheet, invite }) {
  const { owner } = ctx.cast;
  const { di } = ctx;
  await owner.press("People", sheet);
  await owner.press("Remove Di", sheet);
  await expect(owner.mark("Di has answered", sheet)).toHaveCount(0);
  await di.replaceKey({ prf: true });
  const row = di.panel("guarding").locator("li.tc-row", { hasText: "Strict" });
  await di.press("Forget the invitation to Strict", row);
  await di.press("Forget the invitation to Strict for good", row);
  await expect(row).toHaveCount(0);
  const enrollment = await answer(di, invite);
  await addContact(owner, sheet, { enrollment, name: "Di" });
}

/** The circle is made at last, and Ada and Di take their shares on the keys they hold. */
async function armRestored(ctx, sheet) {
  const { owner, ada } = ctx.cast;
  await setRule(owner, sheet, { needed: 2 });
  const form = await setClocks(owner, sheet, {
    minutes: 10,
    hours: 1,
    days: 7,
  });
  await makeCircle(owner, sheet, form);
  for (const guardian of [ada, ctx.di]) {
    const packet = await copyPacketFor(owner, sheet, guardian.name);
    const receipt = await takeWelcome(guardian, packet, { circle: "Strict" });
    await addReceipt(owner, sheet, { receipt, name: guardian.name });
  }
  await expect(sheet.getByText("Armed", { exact: true })).toBeVisible();
  await owner.closeSheet("Start a circle");
}

/** Scenario 4. Leaves Di holding a key that does PRF, for the replacement after it. */
export async function keyRefusals(ctx, state) {
  const { cast } = ctx;
  const { owner, ada } = cast;
  await approveWithoutVerification(ctx, state);
  await approveWithLostKey(ctx, state);
  ctx.di = await cast.person("Di", { prf: false });
  const sheet = await openNewCircle(owner);
  const invite = await nameCircle(owner, sheet, "Strict");
  const enrollmentDi = await acceptWithoutVerification(ctx.di, invite);
  const enrollmentAda = await answer(ada, invite);
  await addContact(owner, sheet, { enrollment: enrollmentAda, name: "Ada" });
  await addContact(owner, sheet, { enrollment: enrollmentDi, name: "Di" });
  await refusedForNoPrf(owner, sheet);
  await swapDi(ctx, { sheet, invite });
  await armRestored(ctx, sheet);
}
