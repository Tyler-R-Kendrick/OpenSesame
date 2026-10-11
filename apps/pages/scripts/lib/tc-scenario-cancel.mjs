/**
 * Scenario 6: the owner cancels a request. Someone is asking for the circle's
 * recovery key, the owner did not expect it, signs a cancellation from the
 * circle's sheet and hands it to the contacts. A contact who had the request
 * open sees it become cancelled, one who had not is told the cancellation was
 * noted and finds the request cancelled when it is pasted, and nobody is
 * offered a way to approve it any more.
 */

import { expect } from "./tc-expect.mjs";
import { ANSWER, openSheet, readRequest } from "./tc-guardian.mjs";

const CANCELLED = "Cancelled by the owner";

/** The owner signs a cancellation of the request, from the circle it was made against. */
async function signCancellation(owner, request) {
  await owner.press("Open Family");
  const circle = owner.sheet("Family");
  await expect(circle).toBeVisible();
  await owner.press("Cancel a request", circle);
  const sheet = owner.sheet("Cancel a request");
  await owner.paste("The request to cancel", request, sheet);
  await owner.press("Sign the cancellation", sheet);
  const cancellation = await owner.copy("cancellation", sheet);
  await owner.closeSheet("Cancel a request");
  await owner.closeSheet("Family");
  return cancellation;
}

/** Bo has the request open and can approve it; the cancellation, pasted into the same sheet, takes that away. */
async function cancelledUnderTheirHands(bo, { request, cancellation }) {
  const sheet = await openSheet(bo, ANSWER);
  await readRequest(bo, sheet, request);
  await expect(bo.mark("Open for approval", sheet)).toBeVisible();
  await expect(bo.key("Approve", sheet)).toBeVisible();
  await bo.paste("A request", cancellation, sheet);
  await bo.press("Read this", sheet);
  await expect(bo.mark(CANCELLED, sheet)).toBeVisible();
  await expect(bo.key("Approve", sheet)).toHaveCount(0);
  await bo.snap("cancelled");
  await bo.closeSheet(ANSWER);
}

/** Ada hears of the cancellation first: it is noted, and the request is found cancelled when it is pasted. */
async function notedBeforeTheRequest(ada, { request, cancellation }) {
  const sheet = await openSheet(ada, ANSWER);
  await ada.paste("A request", cancellation, sheet);
  await ada.press("Read this", sheet);
  await expect(ada.mark("Cancellation noted", sheet)).toBeVisible();
  await readRequest(ada, sheet, request);
  await expect(ada.mark(CANCELLED, sheet)).toBeVisible();
  await expect(ada.key("Approve", sheet)).toHaveCount(0);
  await ada.closeSheet(ANSWER);
}

/** The recipient lets go of the recovery nobody will answer: two presses, the second names what is lost. */
async function giveUp(recipient) {
  await recipient.press("Open Family recovery");
  const sheet = recipient.sheet("Family recovery");
  await recipient.press("Give up on this recovery", sheet);
  await recipient.press("Give up on this recovery for good", sheet);
  await expect(sheet).toHaveCount(0);
  await expect(recipient.key("Open Family recovery")).toHaveCount(0);
}

/** Scenario 6. Cancels the second recovery's request, which scenario 3 left gathering approvals. */
export async function ownerCancels(ctx, state) {
  const { owner, ada, bo, recipient } = ctx.cast;
  const { request } = state.second;
  const cancellation = await signCancellation(owner, request);
  await cancelledUnderTheirHands(bo, { request, cancellation });
  await notedBeforeTheRequest(ada, { request, cancellation });
  await giveUp(recipient);
}
