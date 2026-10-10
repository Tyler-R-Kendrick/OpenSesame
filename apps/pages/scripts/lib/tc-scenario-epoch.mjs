/**
 * Scenario 7: a guardian is replaced, as a new epoch of the circle. Cy has lost
 * their key, so the owner invites Di, changes the circle (Cy leaves, Di joins,
 * the rule and clocks are kept) and makes epoch 2. Everyone who stays or joins
 * takes a new share, Cy is told they are no longer in the circle, and the
 * owner has a new recovery file.
 *
 * The old file no longer opens anything: a guardian's device refuses a request
 * made from it, on the epoch. The new file recovers the item through two
 * contacts of the new epoch, one of them Di. Ada's and Bo's keys are the ones
 * they enrolled with throughout: a share of the new epoch is sealed by the
 * same PRF secret, so neither is replaced here.
 */

import { expect } from "./tc-expect.mjs";
import {
  ANSWER,
  TAKE,
  acceptInvitation,
  openSheet,
  takeWelcome,
} from "./tc-guardian.mjs";
import { addContact, addReceipt, saveRecoveryFile } from "./tc-owner.mjs";
import {
  approveAndAdd,
  releaseAndAdd,
  standing,
  startFrom,
} from "./tc-recovery.mjs";
import { expectRefusal } from "./tc-refusals.mjs";
import { expectOnlyTheItem } from "./tc-scenario-happy.mjs";

const CHANGE = "Change the circle";

/** The owner invites one more person from the circle's sheet; Di answers and the owner adds the answer. */
async function inviteDi(ctx) {
  const { owner } = ctx.cast;
  await owner.press("Open Family");
  const circle = owner.sheet("Family");
  await expect(circle).toBeVisible();
  await owner.press("Invite more people", circle);
  const sheet = owner.sheet("Invite more people");
  await expect(owner.key("Copy invitation", sheet)).toBeVisible();
  const invite = await owner.copy("invitation", sheet);
  const enrollment = await acceptInvitation(ctx.di, invite, "Di");
  await addContact(owner, sheet, { enrollment, name: "Di" });
  await owner.closeSheet("Invite more people");
  await expect(
    owner.mark("Di joins when the circle is changed", circle),
  ).toBeVisible();
  return circle;
}

/** Cy leaves, Di joins, the rule stays two of three, and the next epoch is made. Returns the sheet on its packets. */
async function makeEpochTwo(ctx, circle) {
  const { owner } = ctx.cast;
  await owner.press(CHANGE, circle);
  const sheet = owner.sheet(CHANGE);
  await expect(owner.mark("Di joins at this epoch", sheet)).toBeVisible();
  await owner.press("Remove Cy", sheet);
  await expect(owner.mark("Cy leaves at this epoch", sheet)).toBeVisible();
  await expect(sheet.getByLabel("Needed", { exact: true })).toHaveValue("2");
  await owner.snap("epoch-roster");
  await owner.press("Make the new epoch", sheet);
  await expect(owner.key("Save the recovery file", sheet)).toBeVisible();
  await expect(
    owner.mark("The earlier recovery file no longer opens this circle", sheet),
  ).toBeVisible();
  await owner.snap("epoch-packets");
  return sheet;
}

/** Cy takes the notice: a policy that ends their seat, which needs no key. */
async function takeNotice(cy, packet) {
  const sheet = await openSheet(cy, TAKE);
  await cy.paste("What an owner sent", packet, sheet);
  await expect(sheet.locator(".tc-fact")).toContainText(
    "A new policy for Family, epoch 2",
  );
  await cy.press("Take what was sent", sheet);
  await expect(cy.mark("You are no longer in Family", sheet)).toBeVisible();
  await cy.closeSheet(TAKE);
}

/** Ada, Bo and Di take their shares of epoch 2; Cy takes the notice; the circle is armed again. */
async function handOutEpochTwo(ctx, sheet) {
  const { owner, ada, bo, cy } = ctx.cast;
  for (const guardian of [ada, bo, ctx.di]) {
    const packet = await owner.copy(`${guardian.name}'s packet`, sheet);
    const receipt = await takeWelcome(guardian, packet, { circle: "Family" });
    await addReceipt(owner, sheet, { receipt, name: guardian.name });
  }
  await takeNotice(cy, await owner.copy("Cy's notice", sheet));
  await expect(sheet.getByText("Armed", { exact: true })).toBeVisible();
  await owner.snap("epoch-armed");
}

/** Every device says what it now holds: epoch 2 for the three, nothing for Cy. */
async function expectRows(ctx) {
  const { owner, ada, bo, cy } = ctx.cast;
  const mine = (who) =>
    who.panel("guarding").locator("li.tc-row", { hasText: "Family" });
  for (const guardian of [ada, bo, ctx.di]) {
    await expect(mine(guardian)).toContainText("epoch 2");
    await expect(guardian.mark("Holds a share", mine(guardian))).toBeVisible();
  }
  // A seat that ended is not listed any more: Cy holds nothing for anyone.
  await expect(mine(cy)).toHaveCount(0);
  await expect(
    cy.mark("Nothing held for anyone yet.", cy.panel("guarding")),
  ).toBeVisible();
  const row = owner
    .panel("circles")
    .locator("li.tc-row", { hasText: "Family" });
  await expect(row).toContainText("epoch 2");
}

/** The earlier file starts a request, and a guardian's device refuses it on the epoch. */
async function oldFileIsRefused(ctx, state) {
  const { ada, recipient } = ctx.cast;
  const old = await startFrom(recipient, state.circle.file, "Old laptop");
  const sheet = await openSheet(ada, ANSWER);
  await ada.paste("A request", old.request, sheet);
  await ada.press("Read this", sheet);
  await expectRefusal(ada, { scope: sheet });
  await ada.snap("old-file-refused");
  await ada.closeSheet(ANSWER);
  await recipient.press("Give up on this recovery", old.sheet);
  await recipient.press("Give up on this recovery for good", old.sheet);
  await expect(old.sheet).toHaveCount(0);
}

/** The new file recovers the item through Ada and Di, after the delay, and it is the item and nothing else. */
async function newFileRecovers(ctx, file) {
  const { ada, recipient } = ctx.cast;
  const { di } = ctx;
  const { sheet, request, facts } = await startFrom(
    recipient,
    file,
    "New phone",
  );
  expect(facts).toContain("Epoch 2");
  expect(facts).toContain("Contacts Ada, Bo, Di");
  await approveAndAdd({
    guardian: ada,
    recipient,
    sheet,
    request,
    of: "1 of 2 approved",
  });
  await approveAndAdd({
    guardian: di,
    recipient,
    sheet,
    request,
    of: /^Waits until /,
  });
  await ctx.cast.advance(2);
  await recipient.press("Check the status", sheet);
  await expect(standing(sheet)).toHaveText("0 of 2 shares released");
  await releaseAndAdd({ guardians: [ada, di], recipient, sheet, request });
  await recipient.press("Open the recovery", sheet);
  await expect(sheet).toHaveCount(0);
  const panel = recipient.panel("recovery");
  const saved = await recipient.download("Save the recovered items", panel);
  expectOnlyTheItem(saved);
  await recipient.snap("epoch-recovered");
}

/** Scenario 7. */
export async function guardianReplaced(ctx, state) {
  const { owner } = ctx.cast;
  const circle = await inviteDi(ctx);
  const sheet = await makeEpochTwo(ctx, circle);
  await handOutEpochTwo(ctx, sheet);
  const file = await saveRecoveryFile(
    owner,
    sheet,
    `${ctx.out}/Family-epoch-2.json`,
  );
  await owner.closeSheet(CHANGE);
  await owner.closeSheet("Family");
  await expectRows(ctx);
  await oldFileIsRefused(ctx, state);
  await newFileRecovers(ctx, file);
}
