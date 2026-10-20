/**
 * Scenario 8: a 2-of-3 circle approves a standing share for one credential,
 * and the share is written by the PAM ledger — not by a second sharing path.
 *
 * The owner first puts a person in the vault's local directory, because a
 * standing share names a local principal. The circle's rule is still two of
 * three. Two contacts approve the exact grant, the owner waits out the release
 * delay, and only then may the page write it. Access › Grants shows the same
 * grant, and its own Revoke key removes it.
 */

import { addCapabilities } from "./pages-journey.mjs";
import { expect } from "./tc-expect.mjs";
import { approve } from "./tc-guardian.mjs";
import { visit } from "./tc-owner.mjs";

const ASK = "Ask contacts to approve a share";
const PERSON = "Recovery recipient";

/** The local directory entry a share can name, made through Identity › People. */
async function addPerson(owner) {
  await addCapabilities(owner.page, [
    "Browser-local IAM",
    "Directory provisioning",
  ]);
  await visit(owner.page, "identity?view=people");
  await owner.page.waitForTimeout(900);
  await owner.press("New person");
  const form = owner.page.locator("form");
  await owner.type("Name", PERSON, form);
  await owner.press("Save changes");
  await expect(
    owner.page.getByText(PERSON, { exact: true }).first(),
  ).toBeVisible();
  await owner.openTab();
}

/** The circle sheet, the composed ask, and the owners' two approvals. */
async function askTheCircle(owner, ada, bo) {
  await owner.press("Open Family");
  const circle = owner.sheet("Family");
  await expect(circle).toBeVisible();
  await owner.press(ASK, circle);
  const sheet = owner.sheet(ASK);
  const person = sheet.getByLabel("Person", { exact: true });
  await expect(person).toBeVisible();
  await person.selectOption({ label: PERSON });
  await sheet.getByLabel("Item", { exact: true }).selectOption({
    label: "Bank login",
  });
  await owner.snap("ask-compose");
  await owner.press("Ask the circle", sheet);
  await expect(owner.key("Copy request", sheet)).toBeVisible();
  const request = await owner.copy("request", sheet);
  const first = await approve(ada, request);
  await owner.paste("Approvals", first, sheet);
  await owner.press("Add approvals", sheet);
  await expect(sheet).toContainText("1 of 3 approved");
  const second = await approve(bo, request);
  await owner.paste("Approvals", second, sheet);
  await owner.press("Add approvals", sheet);
  await expect(sheet).toContainText(/2 of 3 approved/);
  await owner.snap("ask-approved");
  return { circle, sheet };
}

/** The delay passes, the owner rechecks, and the one key that writes the share is pressed. */
async function shareIt(ctx, sheet) {
  const { owner } = ctx.cast;
  await ctx.cast.advance(2);
  await owner.press("Check this request again", sheet);
  await expect(owner.key("Share it", sheet)).toBeVisible();
  await owner.snap("ask-authorized");
  await owner.press("Share it", sheet);
  await expect(owner.mark("Shared", sheet)).toBeVisible();
  await owner.snap("ask-shared");
}

/** The PAM ledger's own row: the same person, item, and policy. */
async function expectPamShare(ctx) {
  const { owner } = ctx.cast;
  await visit(owner.page, "access?view=grants#identity-shares");
  await owner.page.waitForTimeout(1_200);
  const row = owner.page
    .locator('[role="treeitem"]')
    .filter({ hasText: `${PERSON} → Bank login` })
    .first();
  await expect(row).toBeVisible();
  await row.click();
  const detail = owner.page.locator(".detail").filter({ hasText: PERSON });
  await expect(detail).toContainText("Share");
  await expect(detail).toContainText("Read");
  await owner.snap("pam-share");
  await owner.press("Revoke", detail);
  await owner.press("Confirm revoke", detail);
  await expect(
    owner.page
      .locator('[role="treeitem"]')
      .filter({ hasText: `${PERSON} → Bank login` }),
  ).toHaveCount(0);
  await owner.snap("pam-revoked");
  await owner.openTab();
}

export async function quorumSharesItem(ctx, state) {
  const { owner, ada, bo } = ctx.cast;
  await addPerson(owner);
  const { circle, sheet } = await askTheCircle(owner, ada, bo);
  await shareIt(ctx, sheet);
  await owner.closeSheet(ASK);
  await owner.closeSheet("Family");
  // The circle is unchanged by an action-only grant.
  await expect(
    owner.panel("circles").locator("li.tc-row", { hasText: "Family" }).first(),
  ).toContainText("2 of 3");
  await expect(circle).toHaveCount(0);
  await expectPamShare(ctx);
  return state;
}
