import { expect } from "@playwright/test";
import { setShowHidden } from "./pages-journey.mjs";

/**
 * Verify the actual New link and keyboard command agree with the active view.
 *
 * The listings walked here are the core ones. Drops are `sharing.drops`, so
 * a device that has approved nothing has no rail row for them (ADR 0130) —
 * asserted below rather than quietly dropped, because a listing that
 * disappears for the wrong reason would otherwise read as a passing gate.
 * Passkey records are optional (ADR 0153). The static walk turns them on
 * before this check, so the listing is there; drops stay off.
 */
export async function checkEditorRoutes(page, check) {
  check(
    (await page
      .locator('.railtree__kids a[href$="/vault?f=passkey"]')
      .count()) > 0,
    "passkey: the listing is there once Passkey records is on",
  );
  for (const gated of ["drop"]) {
    check(
      (await page
        .locator(`.railtree__kids a[href$="/vault?f=${gated}"]`)
        .count()) === 0,
      `${gated}: the listing is absent until its capability is approved`,
    );
  }
  // `trash/` is a hidden entry: the rail lists it once its context menu's
  // "Show hidden items" is checked, and not before.
  check(
    (await page
      .locator('.railtree__kids a[href$="/vault?f=trash"]')
      .count()) === 0,
    "trash: hidden from the rail by default",
  );
  await setShowHidden(page, true);
  for (const filter of ["all", "favorites", "trash", "login"]) {
    const query = filter === "all" ? "" : `?f=${filter}`;
    const listing = page
      .locator(`.railtree__kids a[href$="/vault${query}"]`)
      .first();
    // Trash replaces New item with Restore and Delete permanently. The link
    // from the previous listing unmounts as those keys render.
    if (filter === "trash") {
      await listing.click();
      const create = page.getByRole("link", { name: "New item", exact: true });
      const restore = page.getByRole("button", {
        name: "Restore",
        exact: true,
      });
      const purge = page.getByRole("button", {
        name: "Delete permanently",
        exact: true,
      });
      await expect(create).toHaveCount(0);
      await expect(restore).toBeVisible();
      await expect(purge).toBeVisible();
      check(
        (await create.count()) === 0 &&
          (await restore.count()) === 1 &&
          (await purge.count()) === 1,
        "trash: Restore and Delete permanently replace New item",
      );
      continue;
    }
    const expected = filter === "login" ? `/vault/new/${filter}` : "/vault/new";
    for (const keyboard of [false, true]) {
      await listing.click();
      const create = page.getByRole("link", { name: "New item", exact: true });
      await expect(create).toHaveAttribute("href", new RegExp(`${expected}$`));
      check(
        (await create.getAttribute("href")).endsWith(expected),
        `${filter}: New link has the correct type scope`,
      );
      if (keyboard) {
        await create.focus();
        await page.keyboard.press("n");
      } else await create.click();
      await page.getByLabel("Name", { exact: true }).waitFor();
      check(
        new URL(page.url()).pathname.endsWith(expected),
        `${filter}: ${keyboard ? "keyboard" : "link"} opens ${expected}`,
      );
      check(
        (await page.getByLabel("Type", { exact: true }).count()) ===
          (expected === "/vault/new" ? 1 : 0),
        `${filter}: picker only on the untyped route`,
      );
      await page.getByRole("link", { name: "Cancel", exact: true }).click();
    }
  }
  await setShowHidden(page, false);
}
