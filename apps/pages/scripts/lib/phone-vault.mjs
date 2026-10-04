// The phone's vault is three panes, one at a time: the section tree it opens
// on, the list a tree entry opens, and the item a list row opens — each with a
// key back to the one before it (DESIGN.md § Layout).

/**
 * Open the list of everything from the tree. A no-op where the list is already
 * showing, so a walk can call it whichever pane it finds itself on.
 */
export async function openVaultList(page) {
  const all = page.getByRole("treeitem", { name: /^all\b/i }).first();
  if ((await all.count()) === 0) return false;
  await all.tap();
  await page.locator(".vault[data-pane='list']").waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  return true;
}

/**
 * Wherever a walk finds the vault, leave it on the list with its New item key
 * showing: up out of an item, in from the section tree. A desktop draws the
 * key already, so this is a no-op there.
 */
export async function toTheList(page) {
  const create = page.getByRole("link", { name: "New item", exact: true });
  if (await create.isVisible()) return;
  const back = page
    .getByRole("link", { name: /^Back to (all items|list)$/ })
    .first();
  if (await back.isVisible()) await back.click();
  const all = page.getByRole("treeitem", { name: /^all\b/i }).first();
  if (!(await create.isVisible()) && (await all.isVisible())) await all.click();
}

/**
 * Three panes, one key back each: the item to the list, the list to the
 * section tree. Each is a real tap on a real key, and the pane that answers is
 * read off the shell, so a back that lands one pane too far fails here.
 */
export async function backOutStops(page, stop, { harness, audit }) {
  const pane = () => page.locator(".vault").first().getAttribute("data-pane");
  const back = async (name, expected, what) => {
    await page.getByRole("link", { name }).first().tap();
    await page.waitForTimeout(500);
    harness.check(
      (await pane()) === expected,
      `${stop("back")}: back from ${what}`,
    );
  };
  await back("Back to all items", "list", "an item lands on the list");
  await audit(page, stop("list"));
  await back("Back to sections", "tree", "the list lands on the section tree");
  await audit(page, stop("tree"));
}

/**
 * The phone's tree: importing and exporting are in the row above it, each key
 * at the 44px floor; New is the corner button, pinned over the pane's bottom
 * right and clear of the statusline's prompt; and search is the prompt's own
 * `/?` verb — there is no search key, and typing it lands on the list narrowed
 * to the words. Skipped where the walk is not on the tree, so it can be called
 * wherever the vault is entered.
 */
export async function treeActions(page, stop, { harness, audit }) {
  const pane = () => page.locator(".vault").first().getAttribute("data-pane");
  if ((await pane()) !== "tree") return;
  const row = page.locator(".vault__tree .vtree__keys");
  const keys = await row.locator("a, button").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        name: node.getAttribute("aria-label") ?? node.getAttribute("title"),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    }),
  );
  // The `?` key stands down on a phone: drawn nowhere, so it has no size.
  const shown = keys.filter((key) => key.width > 0);
  harness.check(
    keys.some((key) => key.name === "Export items"),
    `${stop("tree-actions")}: the tree carries the Export items key`,
  );
  harness.check(
    !keys.some((key) => key.name === "New item" || key.name === "Search (/)"),
    `${stop("tree-actions")}: New is the corner button and search is the prompt, neither a key in the row`,
  );
  harness.check(
    shown.length > 0 && shown.every((k) => k.width >= 44 && k.height >= 44),
    `${stop("tree-actions")}: every key is 44px (${shown
      .map((k) => `${k.name} ${k.width}x${k.height}`)
      .join(", ")})`,
  );
  await fabIsPinned(page, stop("tree-actions"), harness);
  await audit(page, stop("tree-actions"));

  const prompt = page.locator("#command-bar-input");
  await prompt.fill("/? zz-no-such-item");
  await prompt.press("Enter");
  await page.waitForTimeout(600);
  harness.check(
    (await pane()) === "list",
    `${stop("tree-actions")}: /? opens the list`,
  );
  const meta = await page.locator(".vault__status-meta").first().textContent();
  harness.check(
    (meta ?? "").includes("/zz-no-such-item"),
    `${stop("tree-actions")}: the list is narrowed to the words (${meta})`,
  );
  harness.check(
    (await page.locator(".vtree__cmd").count()) === 0,
    `${stop("tree-actions")}: no second search box is drawn above the prompt`,
  );
  await fabIsPinned(page, stop("tree-actions"), harness);
  await page.getByRole("link", { name: "Back to sections" }).first().tap();
  await page.waitForTimeout(500);
}

/** The corner button: 56px, in the bottom right, above the statusline. */
async function fabIsPinned(page, label, harness) {
  const fab = await page.evaluate(() => {
    const node = document.querySelector(".fab");
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const strip = document
      .querySelector(".statusline")
      ?.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      right: Math.round(window.innerWidth - box.right),
      clearOfStrip: strip ? box.bottom <= strip.top + 1 : false,
      inRightHalf: box.left > window.innerWidth / 2,
      label: node.getAttribute("aria-label"),
    };
  });
  harness.check(
    fab !== null &&
      fab.label === "New item" &&
      fab.width >= 56 &&
      fab.height >= 56 &&
      fab.inRightHalf &&
      fab.right >= 8 &&
      fab.clearOfStrip,
    `${label}: New item is a 56px corner button above the prompt (${JSON.stringify(fab)})`,
  );
}
