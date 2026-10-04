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
 * The command row above the tree: adding, importing, exporting and searching
 * are on the screen a phone opens on, each key at the 44px floor, and the
 * search key lands on the list with its prompt focused. Skipped where the walk
 * is not on the tree, so it can be called wherever the vault is entered.
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
  for (const name of ["New item", "Export items", "Search (/)"]) {
    harness.check(
      keys.some((key) => key.name === name),
      `${stop("tree-actions")}: the tree carries the ${name} key`,
    );
  }
  harness.check(
    shown.length > 0 && shown.every((k) => k.width >= 44 && k.height >= 44),
    `${stop("tree-actions")}: every key is 44px (${shown
      .map((k) => `${k.name} ${k.width}x${k.height}`)
      .join(", ")})`,
  );
  await audit(page, stop("tree-actions"));
  await row.locator('[title="Search (/)"]').tap();
  await page.waitForTimeout(600);
  harness.check(
    (await pane()) === "list",
    `${stop("tree-actions")}: search opens the list`,
  );
  const focused = await page.evaluate(() =>
    document.activeElement?.getAttribute("aria-label"),
  );
  harness.check(
    focused === "Search items",
    `${stop("tree-actions")}: the search prompt is focused (${focused})`,
  );
  await page.getByRole("link", { name: "Back to sections" }).first().tap();
  await page.waitForTimeout(500);
}

/**
 * A search typed on the list must end when the tree comes back: the list stays
 * mounted behind it, and a filter that survived made "all" draw no rows. Needs
 * an item in the vault (an empty list shows nothing either way) and leaves the
 * walk on the tree it found.
 */
export async function searchEndsWithTheList(page, stop, { harness }) {
  const pane = () => page.locator(".vault").first().getAttribute("data-pane");
  if ((await pane()) !== "tree") return;
  const label = stop("search-round-trip");
  const prompt = page.getByRole("textbox", { name: "Search items" });
  await page.locator('.vault__tree [title="Search (/)"]').tap();
  await page.waitForTimeout(600);
  await prompt.fill("no-such-item-zzz");
  await page.getByRole("link", { name: "Back to sections" }).first().tap();
  await page.waitForTimeout(500);
  await page
    .getByRole("treeitem", { name: /^all\b/i })
    .first()
    .tap();
  await page.waitForTimeout(600);
  const rows = await page.locator('.vault__list [role="treeitem"]').count();
  harness.check(
    (await prompt.count()) === 0,
    `${label}: the search prompt closed with the list`,
  );
  harness.check(rows > 0, `${label}: all shows its items again (${rows} rows)`);
  await page.getByRole("link", { name: "Back to sections" }).first().tap();
  await page.waitForTimeout(500);
}
