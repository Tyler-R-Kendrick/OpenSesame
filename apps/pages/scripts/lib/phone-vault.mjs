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
 * What the tree asks of a thumb: one filled Add key in the bottom corner and
 * the action sheet it opens with New item, Import and Export as full-width
 * rows. Finding is the status-line prompt's `/?` verb — the one text input on
 * the screen, which keeps the words and narrows the list as they are typed; the
 * pane draws no field of its own. Skipped where the walk is not on the tree, so
 * it can be called wherever the vault is entered.
 */
export async function treeActions(page, stop, { harness, audit }) {
  const pane = () => page.locator(".vault").first().getAttribute("data-pane");
  if ((await pane()) !== "tree") return;
  const label = stop("tree-actions");
  const view = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  await treeReach(page, { label, view, harness });
  await audit(page, label);
  await addSheet(page, { label, view, stop, harness, audit });
  await promptSearch(page, { label, pane, harness });
}

/** The Add key: its size, where it rests, what clears. */
async function treeReach(page, { label, view, harness }) {
  const box = (selector) =>
    page
      .locator(selector)
      .first()
      .evaluate((node) => {
        const r = node.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          right: r.right,
          bottom: r.bottom,
        };
      });
  harness.check(
    (await page.locator(".vault__tree .vadd__find").count()) === 0,
    `${label}: the tree draws no search field of its own`,
  );
  const add = await box(".vault__tree .vadd__key");
  harness.check(
    add.w >= 56 && add.h >= 56,
    `${label}: the Add key is at least 56px (${Math.round(add.w)}x${Math.round(add.h)})`,
  );
  harness.check(
    view.w - add.right <= 24 && add.y > view.h / 2,
    `${label}: the Add key rests in the thumb's corner (right edge ${Math.round(view.w - add.right)}px in, top at ${Math.round(add.y)} of ${view.h})`,
  );
  const status = await page
    .locator(".statusline")
    .first()
    .evaluate((node) => node.getBoundingClientRect().top)
    .catch(() => view.h);
  harness.check(
    add.bottom <= status,
    `${label}: the Add key clears the statusline (${Math.round(add.bottom)} <= ${Math.round(status)})`,
  );
  const stray = await page
    .locator(".vault__tree .vtree__keys, .vault__tree .vadd__host > button")
    .evaluateAll(
      (nodes) =>
        nodes.filter((node) => node.getBoundingClientRect().width > 0).length,
    );
  harness.check(
    stray === 0,
    `${label}: no desktop key is drawn beside the Add key`,
  );
}

/** The sheet the Add key opens: its rows, Escape, and New item. */
async function addSheet(page, { label, view, stop, harness, audit }) {
  await page.locator(".vault__tree .vadd__key").tap();
  const menu = page.getByRole("menu", { name: "Add to the vault" });
  await menu
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => undefined);
  const rows = await menu.getByRole("menuitem").evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.getAttribute("aria-label"),
      h: Math.round(node.getBoundingClientRect().height),
      w: Math.round(node.getBoundingClientRect().width),
    })),
  );
  harness.check(
    rows[0]?.name === "New item" && rows.at(-1)?.name === "Export items",
    `${label}: the Add sheet runs New item … Export items (${rows.map((r) => r.name).join(", ")})`,
  );
  harness.check(
    rows.length >= 2 && rows.every((r) => r.h >= 44 && r.w >= view.w * 0.8),
    `${label}: every sheet row is 44px and nearly the full width (${rows.map((r) => `${r.w}x${r.h}`).join(", ")})`,
  );
  await audit(page, stop("add-sheet"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  harness.check(
    (await menu.count()) === 0,
    `${label}: Escape closes the Add sheet`,
  );

  await page.locator(".vault__tree .vadd__key").tap();
  await page.getByRole("menuitem", { name: "New item" }).tap();
  await page.waitForTimeout(600);
  harness.check(
    new URL(page.url()).pathname.endsWith("/vault/new"),
    `${label}: New item in the sheet opens the editor (${new URL(page.url()).pathname})`,
  );
  await page.goBack();
  await page.waitForTimeout(500);
}

/** Search is the prompt: live narrowing, Enter keeps the words, one text input. */
async function promptSearch(page, { label, pane, harness }) {
  const prompt = page.locator("#command-bar-input");
  await prompt.fill("/? zz-no-such-item");
  await page.waitForTimeout(400);
  const live = await page.locator(".vault__status-meta").first().textContent();
  harness.check(
    (live ?? "").includes("/zz-no-such-item"),
    `${label}: the list narrows as the words are typed (${live})`,
  );
  await prompt.press("Enter");
  await page.waitForTimeout(600);
  harness.check((await pane()) === "list", `${label}: Enter opens the list`);
  harness.check(
    (await prompt.inputValue()) === "/? zz-no-such-item",
    `${label}: Enter keeps the words in the prompt`,
  );
  harness.check(
    (await page.locator(".command-bar__status").count()) === 0,
    `${label}: no notice box opens over the prompt`,
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
    `${label}: the prompt is the only text input on screen (${inputs})`,
  );
  await prompt.fill("");
  await page.waitForTimeout(300);
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
  const prompt = page.locator("#command-bar-input");
  const all = () => page.getByRole("treeitem", { name: /^all\b/i }).first();
  await all().tap();
  await page.waitForTimeout(600);
  await prompt.tap();
  await page.keyboard.type("/? no-such-item-zzz");
  await page.waitForTimeout(500);
  await page.getByRole("link", { name: "Back to sections" }).first().tap();
  await page.waitForTimeout(500);
  harness.check(
    (await prompt.inputValue()) === "",
    `${label}: the search prompt emptied with the list`,
  );
  await all().tap();
  await page.waitForTimeout(600);
  const rows = await page.locator('.vault__list [role="treeitem"]').count();
  harness.check(rows > 0, `${label}: all shows its items again (${rows} rows)`);
  await page.getByRole("link", { name: "Back to sections" }).first().tap();
  await page.waitForTimeout(500);
}
