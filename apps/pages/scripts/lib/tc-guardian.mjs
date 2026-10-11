/**
 * What a guardian does in Settings › Trusted contacts › Guarding: accept an
 * invitation with a security key, take what the owner sent (two touches),
 * approve a request and, once the delay has passed, release a share.
 */

import { expect } from "./tc-expect.mjs";

export const ACCEPT = "Accept an invitation";
export const TAKE = "Take what an owner sent";
export const ANSWER = "Answer a request";

/** A head key opens its sheet, and the sheet is there. */
export async function openSheet(guardian, name) {
  await guardian.press(name);
  const sheet = guardian.sheet(name);
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The invitation pasted and read: the card says what is being agreed to. */
export async function readInvitation(guardian, sheet, invite) {
  await guardian.paste("An invitation", invite, sheet);
  await guardian.press("Read this invitation", sheet);
  await expect(guardian.key("Agree", sheet)).toBeVisible();
}

/** A name, and Agree: the key answers, and the answer is the one packet to hand back. */
export async function agree(guardian, sheet, name, { backup = false } = {}) {
  await guardian.type("Your name", name, sheet);
  if (backup)
    await sheet.getByRole("switch", { name: "Add a backup key" }).click();
  await guardian.press("Agree", sheet);
}

/** The whole acceptance, ending with the answer copied and the sheet closed. */
export async function acceptInvitation(guardian, invite, name) {
  const sheet = await openSheet(guardian, ACCEPT);
  await readInvitation(guardian, sheet, invite);
  await agree(guardian, sheet, name);
  await expect(guardian.mark("Agreed", sheet)).toHaveCount(0);
  const enrollment = await guardian.copy("your answer", sheet);
  await guardian.closeSheet(ACCEPT);
  return enrollment;
}

/** The owner's welcome taken: a share (two touches), and the receipt to hand back. */
export async function takeWelcome(guardian, packet, { circle }) {
  const sheet = await openSheet(guardian, TAKE);
  await guardian.paste("What an owner sent", packet, sheet);
  await expect(sheet.locator(".tc-fact")).toContainText(
    `A welcome to ${circle}`,
  );
  await guardian.press("Take what was sent", sheet);
  await expect(guardian.mark("Share taken", sheet)).toBeVisible();
  const receipt = await guardian.copy("your receipt", sheet);
  await guardian.closeSheet(TAKE);
  return receipt;
}

/** A request pasted and read: the sentence it asks, against the policy this device holds. */
export async function readRequest(guardian, sheet, request) {
  await guardian.paste("A request", request, sheet);
  await guardian.press("Read this", sheet);
}

/** Approve a request by touch; the approval is the packet to hand on. */
export async function approve(guardian, request) {
  const sheet = await openSheet(guardian, ANSWER);
  await readRequest(guardian, sheet, request);
  await expect(guardian.mark("Open for approval", sheet)).toBeVisible();
  await guardian.press("Approve", sheet);
  await expect(guardian.key("Copy your approval", sheet)).toBeVisible();
  const approval = await guardian.copy("your approval", sheet);
  await guardian.closeSheet(ANSWER);
  return approval;
}

/** After the delay: the request again, the approvals so far, and the release. */
export async function release(guardian, { request, approvals }) {
  const sheet = await openSheet(guardian, ANSWER);
  await readRequest(guardian, sheet, request);
  await expect(guardian.mark("Ready to release", sheet)).toBeVisible();
  await guardian.paste("The approvals so far", approvals, sheet);
  await guardian.press("Release my share", sheet);
  await expect(guardian.key("Copy your release", sheet)).toBeVisible();
  const released = await guardian.copy("your release", sheet);
  await guardian.closeSheet(ANSWER);
  return released;
}

/** Before the delay a guardian can read the request but is offered no release. */
export async function expectNoReleaseYet(guardian, request) {
  const sheet = await openSheet(guardian, ANSWER);
  await readRequest(guardian, sheet, request);
  await expect(guardian.key("Release my share", sheet)).toHaveCount(0);
  await expect(
    sheet.getByLabel("The approvals so far", { exact: true }),
  ).toHaveCount(0);
  await guardian.closeSheet(ANSWER);
}
