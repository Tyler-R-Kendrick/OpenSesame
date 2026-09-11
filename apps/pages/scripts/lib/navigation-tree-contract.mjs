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

function treeItem(page, name) {
  if (typeof name === "string" || name instanceof RegExp)
    return page.getByRole("treeitem", { name });
  if (name && typeof name === "object" && "name" in name)
    return page.getByRole("treeitem", name);
  return name;
}

async function selectUntil(page, item, max) {
  for (
    let step = 0;
    step < max && (await item.getAttribute("aria-selected")) !== "true";
    step++
  )
    await page.keyboard.press("ArrowDown");
  await expect(item).toHaveAttribute("aria-selected", "true");
}

async function expandNamed(page, _tree, name) {
  const item = treeItem(page, name).first();
  await expect(item).toBeVisible();
  if ((await item.getAttribute("aria-expanded")) === "true") return;
  for (const key of ["ArrowDown", "ArrowUp"]) {
    for (
      let step = 0;
      step < 16 && (await item.getAttribute("aria-selected")) !== "true";
      step++
    )
      await page.keyboard.press(key);
    if ((await item.getAttribute("aria-selected")) === "true") break;
  }
  await expect(item).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(item).toHaveAttribute("aria-expanded", "true");
}

async function accessContract(page, tabTo) {
  const tree = page.getByRole("tree", { name: "Sections", exact: true });
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  await expandNamed(page, tree, /^Access/);
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
  }
  await expandNamed(page, tree, { name: "Grants", exact: true });
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
  await expect(page).toHaveURL(/\/access\?view=grants#identity-shares$/);
  const grants = page.getByRole("treeitem", { name: "Grants", exact: true });
  await page.keyboard.press("ArrowLeft");
  await expect(grants).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/\/access\?view=requests$/);
  await expect(
    page.getByRole("tab", { name: "Requests", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(tree).toBeFocused();
}

async function connectorsContract(page, tabTo) {
  const tree = page.getByRole("tree", { name: "Sections", exact: true });
  await page.keyboard.press("g");
  await page.keyboard.press("c");
  await expandNamed(page, tree, /^Connections/);
  await expandNamed(page, tree, /Add a connection/);
  const groups = page.locator(
    '#catalog-tree [role="treeitem"][aria-level="3"]',
  );
  await expect(groups.first()).toBeVisible();
  await expect(groups.first()).toHaveAttribute("aria-expanded", "false");
  await expandNamed(page, tree, groups.first());
  const leaves = page.locator(
    '#catalog-tree [role="treeitem"][aria-level="4"]',
  );
  await expect(leaves.first()).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: /Load \d+ more/ }),
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
  const loadMore = page.getByRole("treeitem", { name: /Load \d+ more/ });
  const groupCount = await groups.count();
  await selectUntil(page, loadMore, 24);
  await expect(tree).toHaveAttribute(
    "aria-activedescendant",
    await loadMore.getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(groups).not.toHaveCount(groupCount);
  await expect(preview).toBeInViewport();
  await expect(tree).toBeFocused();
}

async function identityContract(page, tabTo) {
  const tree = page.getByRole("tree", { name: "Sections", exact: true });
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expandNamed(page, tree, /^Identity/);
  await expect(
    page.getByRole("treeitem", { name: "People", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: "Applications", exact: true }),
  ).toBeVisible();
  await tabTo(page, tree);
  const people = page.getByRole("treeitem", { name: "People", exact: true });
  if ((await people.getAttribute("aria-selected")) !== "true")
    await page.keyboard.press("ArrowDown");
  await expect(people).toHaveAttribute("aria-selected", "true");
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
