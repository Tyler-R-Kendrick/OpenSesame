import { expect } from "@playwright/test";

/** Verify the actual New link and keyboard command agree with the active view. */
export async function checkEditorRoutes(page, check) {
  for (const filter of ["all", "favorites", "trash", "login", "drop"]) {
    const query = filter === "all" ? "" : `?f=${filter}`;
    const expected = ["login", "drop"].includes(filter)
      ? `/vault/new/${filter}`
      : "/vault/new";
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
