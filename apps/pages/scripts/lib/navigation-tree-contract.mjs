import { expect } from "@playwright/test";
import { localDirectoryContract } from "./local-directory-contract.mjs";

/** Real keyboard selection must not activate connector settings. */
export async function navigationTreeContract(page, tabTo) {
  await connectorsContract(page, tabTo);
  await accessContract(page, tabTo);
  await identityContract(page, tabTo);
  console.log(
    "PASS Access and Identity record subtrees, list/detail/create navigation, connector selection/activation and focus retention",
  );
}

function isString(value) {
  return (
    Object(value) !== value &&
    Object.prototype.toString.call(value) === "[object String]"
  );
}

function isObject(value) {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

function treeItem(page, name) {
  if (isString(name) || name instanceof RegExp)
    return page.getByRole("treeitem", { name });
  if (isObject(name) && "name" in name) return page.getByRole("treeitem", name);
  return name;
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
    "Connectors",
    "Resources",
    "Policies",
  ]) {
    // Every category is the same kind of row: a sibling that opens onto its
    // panels, never a caret-less row one indent left of the others.
    const row = page.getByRole("treeitem", { name, exact: true });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("aria-level", "2");
    await expect(row).toHaveAttribute("aria-expanded", "false");
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
  // The Grants subtree lists each record collection. A guest's book is
  // empty, so Portable grants is not drawn and not listed.
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/\/access\?view=grants#local-grants$/);
  await expect(
    page.locator('.record-workspace[data-section="Access"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("tree", {
      name: "Local application grants items",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".section__head, .access-tabs")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/\/access\?view=grants#identity-shares$/);
  const shares = page.getByRole("treeitem", {
    name: "Identity shares",
    exact: true,
  });
  await expect(shares).toHaveAttribute("aria-selected", "true");
  await accessRecordContract(page, tabTo);
  await tabTo(page, tree);
  const grants = page.getByRole("treeitem", { name: "Grants", exact: true });
  for (
    let step = 0;
    step < 16 && (await grants.getAttribute("aria-selected")) !== "true";
    step++
  )
    await page.keyboard.press("ArrowUp");
  await expect(grants).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(grants).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/\/access\?view=requests$/);
  await expect(
    page.getByRole("treeitem", { name: "Requests", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tree", { name: "Local requests items", exact: true }),
  ).toBeVisible();
  await expect(tree).toBeFocused();
}

async function accessRecordContract(page, tabTo) {
  const list = page.getByRole("tree", {
    name: "Identity shares items",
    exact: true,
  });
  await expect(list.getByRole("treeitem").first()).toBeVisible();
  await tabTo(page, list);
  await page.keyboard.press("Home");
  await expect(page).toHaveURL(/\/access\?view=grants#share-/);
  await expect(list.getByRole("treeitem", { selected: true })).toHaveCount(1);
  await expect(
    page.locator(".record-workspace .detail__head h1"),
  ).toBeVisible();
  await expect(page.locator(".record-workspace .frow").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".record-workspace .detail__head h1"),
  ).toBeVisible();
  const create = page.getByRole("button", {
    name: "Grant identity share",
    exact: true,
  });
  await tabTo(page, create);
  await expect(create).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    /\/access\?view=grants&draft=new#identity-shares$/,
  );
  await expect(
    page.getByRole("heading", { name: "New identity share", exact: true }),
  ).toBeVisible();
  const form = page.locator(".record-workspace .vault__detail form");
  await expect(form).toBeVisible();
  await tabTo(page, form.getByRole("button", { name: "Cancel", exact: true }));
  await page.keyboard.press("Enter");
  await expect(form).toHaveCount(0);
  await expect(page).toHaveURL(/\/access\?view=grants#identity-shares$/);
  await tabTo(page, list);
  await expect(list).toBeFocused();
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
    page.getByRole("treeitem", { name: "Agents", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('.record-workspace[data-section="Identity"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("tree", { name: "Agents items", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".identity-tabs, .section__head")).toHaveCount(0);
  await expect(tree).toBeFocused();
  await page.screenshot({ path: "/tmp/opensesame-identity-tree.png" });
  await localDirectoryContract(page, tabTo);
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await tabTo(page, page.getByRole("button", { name: /^Notifications/ }));
}
