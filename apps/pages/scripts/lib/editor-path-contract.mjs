import { expect } from "@playwright/test";

export async function checkEditorPaths(page, check) {
  const original = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("link", { name: "New item", exact: true }).click();
    const name = page.getByLabel("Name", { exact: true });
    const folder = page.getByLabel("Folder", { exact: true });
    await expect(folder).toBeVisible();
    const count = await folder.locator("option").count();
    await name.fill("./test/login");
    await name.press("Tab");
    await expect(name).toHaveValue("login");
    await expect(folder.locator("option:checked")).toHaveText("test/");
    const geometry = await page.locator(".editor__titlerow").evaluate((row) => {
      const folderRect = row
        .querySelector("select[aria-label=Folder]")
        .getBoundingClientRect();
      const nameRect = row
        .querySelector("input[aria-label=Name]")
        .getBoundingClientRect();
      return {
        folderRight: folderRect.right,
        nameLeft: nameRect.left,
        gapY: Math.abs(
          folderRect.top +
            folderRect.height / 2 -
            nameRect.top -
            nameRect.height / 2,
        ),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    check(
      geometry.folderRight <= geometry.nameLeft &&
        geometry.gapY < 1 &&
        !geometry.overflow,
      `folder precedes the name on one title row at ${width}px`,
    );
    await name.fill("../root-entry");
    await name.press("Tab");
    await expect(name).toHaveValue("root-entry");
    await expect(folder).toHaveValue("");
    await name.fill("../../invalid");
    await name.press("Tab");
    await expect(page.getByRole("alert")).toContainText("vault root");
    await expect(name).toHaveValue("../../invalid");
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
    await page.getByRole("link", { name: "New item", exact: true }).click();
    await expect(folder.locator("option")).toHaveCount(count);
    check(
      true,
      `relative paths resolve on blur and cancel leaves no folder at ${width}px`,
    );
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
  }
  if (original) await page.setViewportSize(original);
}
