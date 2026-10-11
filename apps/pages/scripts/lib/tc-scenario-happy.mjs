/**
 * Scenarios 1 and 2: a 2-of-3 recovery walked end to end through the screens,
 * and the reload that must not lose what was opened.
 *
 * The owner makes the circle (recovering, three contacts, two needed, a one
 * hour delay), the three guardians take their shares, the recipient opens the
 * recovery file and sends the request, two guardians approve, an hour passes on
 * every clock at once, the same two release, and the recipient opens what the
 * circle protected. The page is then reloaded before anything is saved.
 */

import { toTheList } from "./phone-vault.mjs";
import { ITEM, armCircle } from "./tc-cast.mjs";
import { expect } from "./tc-expect.mjs";
import { expectNoReleaseYet } from "./tc-guardian.mjs";
import { visit } from "./tc-owner.mjs";
import {
  approveAndAdd,
  releaseAndAdd,
  standing,
  startFrom,
} from "./tc-recovery.mjs";

export const ARMED = "Armed: every contact has taken their part";

/** Every contact holds a share, and the owner's row says the circle is armed. */
async function expectArmed(cast, guardians) {
  const { owner } = cast;
  await owner.closeSheet("Start a circle");
  const row = owner
    .panel("circles")
    .locator("li.tc-row", { hasText: "Family" });
  await expect(row).toContainText("2 of 3");
  await expect(owner.mark(ARMED, row)).toBeVisible();
  for (const guardian of guardians) {
    const mine = guardian.panel("guarding").locator("li.tc-row", {
      hasText: "Family",
    });
    await expect(guardian.mark("Holds a share", mine)).toBeVisible();
    await expect(guardian.mark("Held", mine)).toBeVisible();
  }
}

/** The recovery file's own facts, read from the owner's signed policy. */
function expectFileFacts(facts) {
  expect(facts).toContain("Protects Everything");
  expect(facts).toContain("Contacts Ada, Bo, Cy");
  expect(facts).toContain("Epoch 1");
}

/** Scenario 1. Leaves the recovery opened and not yet saved. */
export async function happyRecovery(ctx) {
  const { cast } = ctx;
  const { owner, ada, bo, cy, recipient } = cast;
  const guardians = [ada, bo, cy];
  const circle = await armCircle(cast, {
    name: "Family",
    guardians,
    needed: 2,
    hours: 1,
  });
  await expectArmed(cast, guardians);
  const { sheet, request, facts } = await startFrom(recipient, circle.file);
  expectFileFacts(facts);
  await recipient.snap("request-sent");
  const approvals = [];
  approvals.push(
    await approveAndAdd({
      guardian: ada,
      recipient,
      sheet,
      request,
      of: "1 of 2 approved",
    }),
  );
  await expect(
    ada.mark("Approved a request; its release is next", ada.panel("guarding")),
  ).toBeVisible();
  approvals.push(
    await approveAndAdd({
      guardian: cy,
      recipient,
      sheet,
      request,
      of: /^Waits until /,
    }),
  );
  await recipient.snap("approved");
  await expectNoReleaseYet(ada, request);
  await cast.advance(2);
  await recipient.press("Check the status", sheet);
  await expect(standing(sheet)).toHaveText("0 of 2 shares released");
  await releaseAndAdd({ guardians: [ada, cy], recipient, sheet, request });
  await expect(ada.mark("Share released", ada.panel("guarding"))).toBeVisible();
  await expect(bo.mark("Held", bo.panel("guarding"))).toBeVisible();
  await recipient.snap("released");
  await recipient.press("Open the recovery", sheet);
  await expect(sheet).toHaveCount(0);
  await expectRecovered(recipient);
  await recipient.snap("opened");
  return { circle, request, approvals };
}

/** The Recovered row: the circle's name, and a mark that nothing has left the page yet. */
export async function expectRecovered(recipient) {
  const row = recipient
    .panel("recovery")
    .locator("li.tc-row", { hasText: "Recovered" });
  await expect(row).toContainText("Family");
  await expect(recipient.mark("Not saved yet", row)).toBeVisible();
  return row;
}

/** What the saved file may hold: the item, in full, and nobody else's anything. */
export function expectOnlyTheItem(saved) {
  const document = JSON.parse(saved.text);
  const items = document.accounts.flatMap((account) => account.items);
  expect(items.map((item) => item.title)).toEqual([ITEM.name]);
  expect(saved.text).toContain(ITEM.secret);
  for (const other of [
    "Ada",
    "Bo",
    "Cy",
    "Owner",
    "osq1",
    "guardian",
    "trusted",
  ]) {
    expect(saved.text, `the file holds no ${other}`).not.toContain(other);
  }
}

/** Open the recovery again after a reload, take the items by file and by the Import sheet. */
export async function reloadSafety(ctx) {
  const { recipient } = ctx.cast;
  await recipient.reload();
  const panel = recipient.panel("recovery");
  await expect(
    panel.locator("li.tc-row", { hasText: "Recovered" }),
  ).toHaveCount(0);
  await recipient.press("Open Family recovery");
  const sheet = recipient.sheet("Family recovery");
  await expect(standing(sheet)).toHaveText("2 of 2 shares released");
  await recipient.press("Open the recovery", sheet);
  await expect(sheet).toHaveCount(0);
  const row = await expectRecovered(recipient);
  const saved = await recipient.download("Save the recovered items", panel);
  expect(saved.name).toBe("recovered-Family.json");
  expectOnlyTheItem(saved);
  await expect(recipient.mark("Saved to a file", row)).toBeVisible();
  await expect(recipient.key("Open Family recovery")).toHaveCount(0);
  await recipient.snap("saved");
  await putInVault(recipient, row);
  await recipient.reopenAtTab();
  await expect(panel.locator("li.tc-row")).toHaveCount(0);
  await expect(
    recipient.mark("No recoveries in progress.", panel),
  ).toBeVisible();
}

/** The vault's own Import sheet takes the recovered file, previews it and writes it. */
async function putInVault(recipient, row) {
  await recipient.press("Put them in this vault", row);
  const imp = recipient.sheet("Import items");
  await expect(imp).toBeVisible();
  await expect(imp.getByRole("rowheader", { name: ITEM.name })).toBeVisible();
  await recipient.snap("import");
  await recipient.press("Import 1 item", imp);
  await expect(imp).toContainText("Imported");
  await recipient.press("Done", imp);
  await expect(imp).toHaveCount(0);
  await expect(recipient.mark("Put in this vault", row)).toBeVisible();
  await visit(recipient.page, "vault");
  // A phone opens the vault on its section tree: the list is one tap further.
  await toTheList(recipient.page);
  await expect(
    recipient.page.getByText(ITEM.name).filter({ visible: true }).first(),
  ).toBeVisible();
  await recipient.snap("in-the-vault");
  await recipient.openTab();
}
