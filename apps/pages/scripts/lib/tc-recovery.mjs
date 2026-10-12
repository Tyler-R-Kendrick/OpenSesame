/**
 * A recovery as the screens carry it: the recipient's request goes to the
 * guardians by clipboard, each one approves by touch, the approvals come back,
 * time passes, the guardians release, and the recipient opens what they were
 * released. Each step asserts what the recipient's sheet says before it moves
 * on, so a paste that did nothing cannot pass as one that did.
 */

import fs from "node:fs";
import { expect } from "./tc-expect.mjs";
import { approve, release } from "./tc-guardian.mjs";
import { addAnswer, startRecovery } from "./tc-recipient.mjs";

/** The one fact the recovery sheet states about where it stands ("1 of 2 approved"). */
export const standing = (sheet) => sheet.locator(".found__name").first();

/** The recipient starts a recovery from the owner's file and takes the request to hand out. */
export async function startFrom(recipient, file, device = "New laptop") {
  const body = fs.readFileSync(file.file, "utf8");
  const { sheet, facts } = await startRecovery(recipient, {
    file: { name: file.name, body },
    device,
  });
  await expect(standing(sheet)).toHaveText(/^0 of \d+ approved$/);
  const request = await recipient.copy("the request", sheet);
  return { sheet, request, facts };
}

/** A guardian approves the request and the recipient adds the approval. */
export async function approveAndAdd({
  guardian,
  recipient,
  sheet,
  request,
  of,
}) {
  const approval = await approve(guardian, request);
  await addAnswer(recipient, sheet, approval);
  await expect(standing(sheet)).toHaveText(of);
  return approval;
}

/** Each guardian releases a share against the approvals, and the recipient adds each release. */
export async function releaseAndAdd({ guardians, recipient, sheet, request }) {
  const approvals = await recipient.copy("the approvals", sheet);
  const releases = [];
  for (const [index, guardian] of guardians.entries()) {
    const released = await release(guardian, { request, approvals });
    releases.push(released);
    await addAnswer(recipient, sheet, released);
    await expect(standing(sheet)).toHaveText(
      `${index + 1} of ${guardians.length} shares released`,
    );
  }
  return releases;
}
