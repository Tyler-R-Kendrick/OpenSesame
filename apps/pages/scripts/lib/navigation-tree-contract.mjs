import { expect } from "@playwright/test";
import { localDirectoryContract } from "./local-directory-contract.mjs";

/** Real keyboard selection must not activate connector settings. */
export async function navigationTreeContract(page, tabTo) {
  await connectorsContract(page, tabTo);
  await accessContract(page, tabTo);
  await identityContract(page, tabTo);
  console.log(
    "PASS Access tab subtrees, Identity subtrees, connector selection/activation, indexed Load more and focus retention",
  );
}

async function accessContract(page, tabTo) {
  const tree = page.getByRole("tree", { name: "Sections", exact: true });
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  for (const name of [
    "Grants",
    "Requests",
    "Sessions",
    "Resources",
    "Policies",
  ]) {
    await expect(
      page.getByRole("treeitem", { name, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("treeitem", { name, exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
  }
  await expect(page.locator("#grants-tree")).toBeVisible();
  await expect(
    page.getByRole("treeitem", {
      name: "Local application grants",
      exact: true,
    }),
  ).toBeVisible();
  await tabTo(page, tree);
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/\/access\?view=grants#local-grants$/);
  await expect(
    page.getByRole("tab", { name: "Grants", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/\/access\?view=requests$/);
  await expect(
    page.getByRole("tab", { name: "Requests", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(tree).toBeFocused();
}

async function connectorsContract(page, tabTo) {
  await page.keyboard.press("g");
  await page.keyboard.press("c");
  const tree = page.getByRole("tree", { name: "Sections", exact: true });
  const groups = page.locator('#catalog-tree [role="treeitem"][aria-level="3"]');
  const leaves = page.locator('#catalog-tree [role="treeitem"][aria-level="4"]');
  await expect(groups.first()).toHaveAttribute("aria-expanded", "true");
  await expect(leaves).toHaveCount(12);
  await expect(
    page.getByRole("treeitem", { name: /Load 12 more/ }),
  ).toBeVisible();
  await tabTo(page, tree);
  const selectedLeaf = page.locator(
    '#catalog-tree [role="treeitem"][aria-level="4"][aria-selected="true"]',
  );
  for (let step = 0; step < 8 && (await selectedLeaf.count()) === 0; step++)
    await page.keyboard.press("ArrowDown");
  await expect(selectedLeaf).toHaveCount(1);
  await expect(page).toHaveURL(/\/connections#catalog-/);
  const preview = page.locator(".conn-tile.is-selected");
  await expect(preview).toBeInViewport();
  await expect(preview).toHaveCSS("outline-style", "solid");
  await page.screenshot({ path: "/tmp/opensesame-connector-selected.png" });
  const destination = await selectedLeaf.getAttribute("href");
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
  const loadMore = page.getByRole("treeitem", { name: /Load 12 more/ });
  for (
    let step = 0;
    step < 24 && (await loadMore.getAttribute("aria-selected")) !== "true";
    step++
  )
    await page.keyboard.press("ArrowDown");
  await expect(loadMore).toHaveAttribute("aria-selected", "true");
  await expect(tree).toHaveAttribute(
    "aria-activedescendant",
    await loadMore.getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(leaves).toHaveCount(24);
  await expect(selectedLeaf).not.toHaveText(/Load|Loading/);
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
