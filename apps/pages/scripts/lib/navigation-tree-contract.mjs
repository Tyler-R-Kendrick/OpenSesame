import { expect } from "@playwright/test";
import { localDirectoryContract } from "./local-directory-contract.mjs";

/** Real keyboard selection must not activate connector settings. */
export async function navigationTreeContract(page, tabTo) {
  await connectorsContract(page, tabTo);
  await identityContract(page, tabTo);
  console.log(
    "PASS Identity subtrees, connector selection/activation, indexed Load more and focus retention",
  );
}

async function connectorsContract(page, tabTo) {
  await page.keyboard.press("g");
  await page.keyboard.press("c");
  const tree = page.getByRole("tree", { name: "Sections", exact: true });
  const rows = page.locator('#catalog-tree [role="treeitem"]');
  await expect(rows).toHaveCount(13);
  await tabTo(page, tree);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const selected = page.locator('#catalog-tree [aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(page).toHaveURL(/\/connections#catalog-/);
  const preview = page.locator(".conn-tile.is-selected");
  await expect(preview).toBeInViewport();
  await expect(preview).toHaveCSS("outline-style", "solid");
  await page.screenshot({ path: "/tmp/opensesame-connector-selected.png" });
  const destination = await selected.getAttribute("href");
  const selectionUrl = page.url();
  for (const key of ["ArrowRight", "l"]) {
    await page.keyboard.press(key);
    await expect(page).toHaveURL(selectionUrl);
  }
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${destination}$`));
  await page.goBack();
  await expect(preview).toBeInViewport();
  await tabTo(page, tree);
  for (let index = 0; index < 12; index++)
    await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveText("Load 12 more");
  await expect(rows).toHaveCount(13);
  await expect(tree).toHaveAttribute(
    "aria-activedescendant",
    await selected.getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(rows).toHaveCount(25);
  await expect(selected).not.toHaveText(/Load|Loading/);
  await expect(preview).toBeInViewport();
  await expect(tree).toBeFocused();
}

async function identityContract(page, tabTo) {
  const tree = page.getByRole("tree", { name: "Sections", exact: true });
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expect(
    page.getByRole("treeitem", { name: "People", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: "Applications", exact: true }),
  ).toBeVisible();
  await tabTo(page, tree);
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/\/identity\?view=agents$/);
  await expect(
    page.getByRole("tab", { name: "Agents", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(tree).toBeFocused();
  await page.screenshot({ path: "/tmp/opensesame-identity-tree.png" });
  await localDirectoryContract(page, tabTo);
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await tabTo(page, page.getByRole("button", { name: /^Notifications/ }));
}
