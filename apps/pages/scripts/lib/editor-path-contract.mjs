import { expect } from "@playwright/test";
import { listedTypes } from "./editor-type.mjs";
import { toTheList } from "./phone-vault.mjs";
import { expectInTray } from "./tray-contract.mjs";

/** How many rows the folder segment lists, opened with a click and closed again. */
async function foldersListed(page, folder) {
  await folder.click();
  const rows = await page
    .getByRole("listbox", { name: "Folder choices" })
    .getByRole("option")
    .count();
  await page.keyboard.press("Escape");
  return rows;
}

export async function checkEditorPaths(page, check) {
  const original = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await toTheList(page);
    await page.getByRole("link", { name: "New item", exact: true }).click();
    const name = page.getByLabel("Name", { exact: true });
    const folder = page.getByLabel("Folder", { exact: true });
    const type = page.getByLabel("Type", { exact: true });
    await expect(folder).toBeVisible();
    await expect(folder).toHaveValue("./");
    const count = await foldersListed(page, folder);
    // A path typed at the start of the name becomes the folder as its slash
    // is typed: no blur, no second control to reach for.
    await name.fill("./test/login");
    await expect(name).toHaveValue("login");
    await expect(folder).toHaveValue("test/");
    const geometry = await page.locator(".editor__titlerow").evaluate((row) => {
      const rect = (selector) =>
        row.querySelector(selector).getBoundingClientRect();
      const folderRect = rect("input[aria-label=Folder]");
      const nameRect = rect("input[aria-label=Name]");
      const typeRect = rect("input[aria-label=Type]");
      const middle = (box) => box.top + box.height / 2;
      return {
        folderRight: folderRect.right,
        nameLeft: nameRect.left,
        nameRight: nameRect.right,
        typeLeft: typeRect.left,
        gapY: Math.max(
          Math.abs(middle(folderRect) - middle(nameRect)),
          Math.abs(middle(typeRect) - middle(nameRect)),
        ),
        folderInk: getComputedStyle(
          row.querySelector("input[aria-label=Folder]"),
        ).color,
        typeInk: getComputedStyle(row.querySelector("input[aria-label=Type]"))
          .color,
        nameInk: getComputedStyle(row.querySelector("input[aria-label=Name]"))
          .color,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check(
      geometry.folderRight <= geometry.nameLeft &&
        geometry.nameRight <= geometry.typeLeft &&
        geometry.gapY < 1 &&
        !geometry.overflow,
      `folder, name and type share one title row, in that order, at ${width}px`,
    );
    check(
      geometry.folderInk === geometry.typeInk &&
        geometry.folderInk !== geometry.nameInk,
      `folder and type are drawn apart from the name at ${width}px`,
    );
    await name.fill("../root-entry");
    await expect(name).toHaveValue("root-entry");
    await expect(folder).toHaveValue("./");
    await name.fill("../../invalid");
    await name.press("Tab");
    await expectInTray(page, "vault root");
    await expect(name).toHaveValue("../../invalid");
    // The folder takes only what its list offers: typed nonsense is put back.
    await folder.click();
    await folder.pressSequentially("not-a-folder");
    await name.click();
    await expect(folder).toHaveValue("./");
    // So does the type: only a listed extension is ever held.
    const before = await type.inputValue();
    await type.click();
    await type.pressSequentially(".nope");
    await name.click();
    await expect(type).toHaveValue(before);
    check(
      (await listedTypes(page)).length > 0,
      `the type segment lists the types there are at ${width}px`,
    );
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
    await page.getByRole("link", { name: "New item", exact: true }).click();
    check(
      (await foldersListed(page, folder)) === count,
      `a typed path resolves as typed and cancel leaves no folder at ${width}px`,
    );
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
  }
  if (original) await page.setViewportSize(original);
}
