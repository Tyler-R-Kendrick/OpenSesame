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
 * The phone's vault actions, measured. The tree carries Import and Export as
 * labelled full-width rows (a word and a glyph, 44px or taller) and no strip of
 * keys; the list's header is back and the view it shows, named, as one choice
 * the width of the rest; New is the corner button, pinned over the pane's
 * bottom right and clear of the statusline; and search is the status-line
 * prompt's `/?` verb — the one text input on the screen, which keeps the words
 * and narrows the list as they are typed. Skipped where the walk is not on the
 * tree, so it can be called wherever the vault is entered.
 */
export async function treeActions(page, stop, { harness, audit }) {
  const pane = () => page.locator(".vault").first().getAttribute("data-pane");
  if ((await pane()) !== "tree") return;
  const rows = await page
    .locator(".vault__tree .vtools .vtool")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return {
          name: node.getAttribute("aria-label"),
          label: node.textContent?.trim(),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }),
    );
  harness.check(
    rows.some((r) => r.name === "Export items" && r.label === "Export items"),
    `${stop("tree-actions")}: Export is a labelled row on the tree (${JSON.stringify(rows)})`,
  );
  harness.check(
    rows.length > 0 && rows.every((r) => r.height >= 44 && r.width >= 280),
    `${stop("tree-actions")}: every tool row is 44px tall and full width`,
  );
  harness.check(
    (await page.locator(".vault__tree .vtree__pathbar").count()) === 0,
    `${stop("tree-actions")}: the tree carries no strip of keys`,
  );
  await fabIsPinned(page, stop("tree-actions"), harness);
  await audit(page, stop("tree-actions"));

  await page
    .getByRole("treeitem", { name: /^all\b/i })
    .first()
    .tap();
  await page.waitForTimeout(600);
  const header = await page.evaluate(() => {
    const bar = document.querySelector(".vault__list .vtree__pathbar");
    const view = bar?.querySelector(".vfilter__open");
    if (!bar || !view) return null;
    const box = view.getBoundingClientRect();
    // The `?` shortcuts key stands down on a touch device: drawn nowhere.
    const keys = [...bar.querySelectorAll("a, button")].filter(
      (n) => n.getBoundingClientRect().width > 0,
    );
    return {
      height: Math.round(box.height),
      share: Math.round((box.width / bar.getBoundingClientRect().width) * 100),
      text: view.textContent?.trim(),
      keys: keys.length,
    };
  });
  harness.check(
    header !== null && header.height >= 44 && header.share >= 70 && header.text,
    `${stop("tree-actions")}: the header names the view as one wide choice (${JSON.stringify(header)})`,
  );
  harness.check(
    header !== null && header.keys === 2,
    `${stop("tree-actions")}: the header is back and the view, nothing else`,
  );

  const prompt = page.locator("#command-bar-input");
  await prompt.fill("/? zz-no-such-item");
  await page.waitForTimeout(400);
  const live = await page.locator(".vault__status-meta").first().textContent();
  harness.check(
    (live ?? "").includes("/zz-no-such-item"),
    `${stop("tree-actions")}: the list narrows as the words are typed (${live})`,
  );
  await prompt.press("Enter");
  await page.waitForTimeout(500);
  harness.check(
    (await prompt.inputValue()) === "/? zz-no-such-item",
    `${stop("tree-actions")}: Enter keeps the words in the prompt`,
  );
  harness.check(
    (await page.locator(".command-bar__status").count()) === 0,
    `${stop("tree-actions")}: no notice box opens over the prompt`,
  );
  const inputs = await page.evaluate(
    () =>
      [...document.querySelectorAll("input, textarea")].filter((el) => {
        const type = el.getAttribute("type") ?? "text";
        if (["file", "hidden", "checkbox", "radio"].includes(type))
          return false;
        if (el.classList.contains("visually-hidden")) return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }).length,
  );
  harness.check(
    inputs === 1,
    `${stop("tree-actions")}: the prompt is the only text input on screen (${inputs})`,
  );
  await fabIsPinned(page, stop("tree-actions"), harness);
  await prompt.fill("");
  await page.waitForTimeout(300);
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
