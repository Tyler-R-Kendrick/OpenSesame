import { expect } from "@playwright/test";

/** Read a row's position, then use the listing's real count-prefixed motion. */
async function chooseRow(page, tree, row, tabTo, activate = true) {
  await expect(row).toBeVisible();
  const index = await row.evaluate((node) =>
    [
      ...node.closest('[role="tree"]').querySelectorAll('[role="treeitem"]'),
    ].indexOf(node),
  );
  await tabTo(page, tree);
  await page.keyboard.type(`${index + 1}gg`);
  if (activate) await page.keyboard.press("Enter");
}

export async function openIdentityView(page, tabTo, name) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  // The jump must finish at the root before taking a row index. On a phone,
  // a list/detail route hides the section tree; the shell's drawer also has
  // a tree named Sections, so use the workspace's actual navigation pane.
  await expect(page).toHaveURL(/\/identity\/?$/);
  const narrow = page.viewportSize().width <= 900;
  const workspace = page.locator('.record-workspace[data-section="Identity"]');
  if (narrow) await expect(workspace).toHaveAttribute("data-pane", "tree");
  const tree = (narrow ? workspace.locator(".vault__tree") : page)
    .getByRole("tree", { name: "Sections", exact: true })
    .filter({ visible: true })
    .first();
  await tabTo(page, tree);
  const identity = tree.getByRole("treeitem", { name: /^Identity/i });
  if ((await identity.getAttribute("aria-expanded")) !== "true") {
    const index = await identity.evaluate((node) =>
      [
        ...node.closest('[role="tree"]').querySelectorAll('[role="treeitem"]'),
      ].indexOf(node),
    );
    await page.keyboard.type(`${index + 1}gg`);
    await page.keyboard.press("ArrowRight");
  }
  const category = tree.getByRole("treeitem", { name, exact: true });
  const expanded = (await category.getAttribute("aria-expanded")) === "true";
  // Expanded directories preview on motion; collapsed ones need Enter. On a
  // phone, that preview replaces the tree, so a second Enter could open a file.
  await chooseRow(page, tree, category, tabTo, !expanded);
  await expect(
    page.locator('.record-workspace[data-section="Identity"]'),
  ).toBeVisible();
}

export async function openIdentityRecord(page, tabTo, name) {
  const tree = page.locator('.record-workspace .vtree__rows[role="tree"]');
  const row = tree.getByRole("treeitem").filter({ hasText: name }).first();
  await chooseRow(page, tree, row, tabTo);
  await expect(
    page.locator(".vault__detail").getByRole("heading", { name, exact: true }),
  ).toBeVisible();
}

export async function identityList(page, tabTo) {
  const back = page
    .locator(".record-workspace__back")
    .filter({ visible: true });
  if (await back.count()) {
    await tabTo(page, back);
    await page.keyboard.press("Enter");
  }
}

export async function expectIdentityRefusal(page, tabTo, text) {
  const bell = page
    .getByRole("button", { name: /^Notifications/ })
    .filter({ visible: true });
  if (!(await bell.count())) {
    await tabTo(
      page,
      page
        .getByRole("button", { name: /^More/ })
        .filter({ visible: true })
        .first(),
    );
    await page.keyboard.press("Enter");
  }
  await tabTo(
    page,
    page
      .getByRole("button", { name: /^Notifications/ })
      .filter({ visible: true })
      .first(),
  );
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Notifications" });
  await expect(sheet).toContainText(text);
  await tabTo(page, sheet.getByRole("button", { name: "Close", exact: true }));
  await page.keyboard.press("Enter");
  await expect(sheet).toBeHidden();
}
