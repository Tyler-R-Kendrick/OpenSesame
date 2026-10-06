// The phone's vault is three panes, one at a time: the section tree it opens
// on, the list a tree entry opens, and the item a list row opens — each with a
// key back to the one before it (DESIGN.md § Layout).

import { addSlide, fabIsPinned } from "./phone-add-button.mjs";

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
  const back = page
    .getByRole("link", { name: /^Back to (all items|list)$/ })
    .first();
  const all = page.getByRole("treeitem", { name: /^all\b/i }).first();
  // A viewport change re-renders the shell a frame or more later, and a busy
  // main thread (a runner, packs installing) stretches that. Reading three
  // `isVisible()`s the instant it changes sees none of the panes and acts on
  // nothing, so wait for whichever pane the shell settles on.
  await create
    .or(back)
    .or(all)
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  // The pane, not the New item key: the + is drawn on the tree pane too.
  const pane = () => page.locator(".vault").first().getAttribute("data-pane");
  if ((await pane()) === "list") return;
  if (await back.isVisible()) {
    await back.click();
    await create.or(all).first().waitFor({ state: "visible", timeout: 15000 });
    if ((await pane()) === "list") return;
  }
  if (await all.isVisible()) await all.click();
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
 * The phone's vault actions, measured. The tree is the sections and nothing
 * else: no strip of keys, no tool rows. Add is one button in the bottom corner
 * — the `+`, one tap, and a hold that slides to Import or Export — and the ellipsis and
 * a real long press on the `+` open the same menu of the alternatives (Import,
 * Export), without navigating. The list's header is back and the view it
 * shows, named, as one choice the width of the rest. Search is the status-line
 * prompt's `/?` verb — the one text input on the screen, which keeps the words
 * and narrows the list as they are typed. Skipped where the walk is not on the
 * tree, so it can be called wherever the vault is entered.
 */
export async function treeActions(page, stop, { harness, audit }) {
  const pane = () => page.locator(".vault").first().getAttribute("data-pane");
  if ((await pane()) !== "tree") return;
  harness.check(
    (await page
      .locator(".vault__tree .vtree__pathbar, .vault__tree .vtools")
      .count()) === 0,
    `${stop("tree-actions")}: the tree carries no strip of keys and no tool rows`,
  );
  await fabIsPinned(page, stop("tree-actions"), harness);
  await addSlide(page, stop("tree-actions"), harness, { stop, audit });
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

/**
 * The Back keys climb the history instead of adding to it. The Navigation
 * API's own entry index is the ground truth: a key that pushed the pane it
 * climbed to would leave the index one higher each time, and the system Back
 * button would walk back through every pane just visited. Needs an item in the
 * vault (the deepest leg opens it) and leaves the walk on the tree it found.
 */
export async function backKeysPop(page, stop, { harness }) {
  const pane = () => page.locator(".vault").first().getAttribute("data-pane");
  if ((await pane()) !== "tree") return;
  const label = stop("back-keys-pop");
  const entry = () =>
    page.evaluate(() => window.navigation?.currentEntry?.index);
  const tap = async (locator) => {
    await locator.first().tap();
    await page.waitForTimeout(500);
  };
  const tree = await entry();
  harness.check(
    Number.isInteger(tree),
    `${label}: the Navigation API is there`,
  );
  await tap(page.getByRole("treeitem", { name: /^all\b/i }));
  const list = await entry();
  await tap(page.locator('.vault__list [role="treeitem"]'));
  const item = await entry();
  await tap(page.getByRole("link", { name: "Back to all items" }));
  const backToList = await entry();
  await tap(page.getByRole("link", { name: "Back to sections" }));
  const backToTree = await entry();
  harness.check(
    list === tree + 1 && item === tree + 2,
    `${label}: going down adds one entry a pane (${tree}, ${list}, ${item})`,
  );
  harness.check(
    backToList === list,
    `${label}: Back to all items returns to the list's entry (${backToList}, expected ${list})`,
  );
  harness.check(
    backToTree === tree,
    `${label}: Back to sections returns to the tree's entry (${backToTree}, expected ${tree})`,
  );
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

/** The walks that start from the tree with an item in the vault and end on it. */
export async function treeWalks(page, stop, ctx) {
  await backKeysPop(page, stop, ctx);
  await searchEndsWithTheList(page, stop, ctx);
}
