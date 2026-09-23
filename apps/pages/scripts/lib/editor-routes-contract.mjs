import { expect } from "@playwright/test";

/**
 * Verify the actual New link and keyboard command agree with the active view.
 *
 * The listings walked here are the core ones. Drops are `sharing.drops`, so
 * a device that has approved nothing has no rail row for them (ADR 0130) —
 * asserted below rather than quietly dropped, because a listing that
 * disappears for the wrong reason would otherwise read as a passing gate.
 * Passkey records are always on (ADR 0135), so their listing is there.
 */
export async function checkEditorRoutes(page, check) {
  check(
    (await page
      .locator('.railtree__kids a[href$="/vault?f=passkey"]')
      .count()) > 0,
    "passkey: the listing is there with nothing chosen (always on)",
  );
  for (const gated of ["drop"]) {
    check(
      (await page
        .locator(`.railtree__kids a[href$="/vault?f=${gated}"]`)
        .count()) === 0,
      `${gated}: the listing is absent until its capability is approved`,
    );
  }
  for (const filter of ["all", "favorites", "trash", "login"]) {
    const query = filter === "all" ? "" : `?f=${filter}`;
    const expected = filter === "login" ? `/vault/new/${filter}` : "/vault/new";
    for (const keyboard of [false, true]) {
      await page
        .locator(`.railtree__kids a[href$="/vault${query}"]`)
        .first()
        .click();
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
}
