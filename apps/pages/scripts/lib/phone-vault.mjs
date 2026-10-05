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
  if (await create.isVisible()) return;
  if (await back.isVisible()) {
    await back.click();
    await create.or(all).first().waitFor({ state: "visible", timeout: 15000 });
  }
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
 * The phone's vault actions, measured. The tree is the sections and nothing
 * else: no strip of keys, no tool rows. Add is one button in the bottom corner
 * — the `+`, one tap, with a vertical ellipsis attached — and the ellipsis and
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
  await addMenu(page, stop("tree-actions"), harness, { stop, audit });
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

/** The Add button: `+` 56px and an attached ellipsis, bottom right, above the prompt. */
async function fabIsPinned(page, label, harness) {
  const fab = await page.evaluate(() => {
    const node = document.querySelector(".fab");
    const add = node?.querySelector(".fab__add");
    const more = node?.querySelector(".fab__more");
    if (!node || !add || !more) return null;
    const box = node.getBoundingClientRect();
    const plus = add.getBoundingClientRect();
    const dots = more.getBoundingClientRect();
    const strip = document
      .querySelector(".statusline")
      ?.getBoundingClientRect();
    return {
      plus: `${Math.round(plus.width)}x${Math.round(plus.height)}`,
      plusOk: plus.width >= 56 && plus.height >= 56,
      dots: `${Math.round(dots.width)}x${Math.round(dots.height)}`,
      dotsOk: dots.width >= 44 && dots.height >= 44,
      attached: Math.abs(dots.left - plus.right) <= 1,
      right: Math.round(window.innerWidth - box.right),
      clearOfStrip: strip ? box.bottom <= strip.top + 1 : false,
      inRightHalf: box.left > window.innerWidth / 2,
      lowerHalf: box.top > window.innerHeight / 2,
      label: add.getAttribute("aria-label"),
      more: more.getAttribute("aria-label"),
    };
  });
  harness.check(
    fab !== null &&
      fab.label === "New item" &&
      fab.more === "More ways to add" &&
      fab.plusOk &&
      fab.dotsOk &&
      fab.attached &&
      fab.inRightHalf &&
      fab.lowerHalf &&
      fab.right >= 8 &&
      fab.right <= 24 &&
      fab.clearOfStrip,
    `${label}: Add is a + (56px) with an attached ellipsis (44px+), bottom right, above the prompt (${JSON.stringify(fab)})`,
  );
}

/** The menu behind the Add button: by the ellipsis, by a real long press, and what it starts. */
async function addMenu(page, label, harness, { stop, audit }) {
  const entries = () =>
    page.locator('[role="menuitem"]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        name: node.textContent?.trim(),
        height: Math.round(node.getBoundingClientRect().height),
      })),
    );
  const where = () => page.evaluate(() => location.pathname);
  const before = await where();
  await page.locator(".fab__more").tap();
  await page.waitForTimeout(400);
  const byEllipsis = await entries();
  harness.check(
    byEllipsis.map((e) => e.name).join("|") === "Import items|Export items" &&
      byEllipsis.every((e) => e.height >= 44),
    `${label}: the ellipsis lists Import and Export at 44px+ (${JSON.stringify(byEllipsis)})`,
  );
  await audit(page, stop("add-menu"));
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null),
    page.getByRole("menuitem", { name: "Import items" }).tap(),
  ]);
  harness.check(
    chooser !== null,
    `${label}: Import starts the OS file picker from the menu tap`,
  );
  await page.waitForTimeout(300);
  // A real hold, as raw touch events: the app's own recognizer must see it,
  // and the lift that ends it must not follow the \`+\` link.
  const box = await page.locator(".fab__add").boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [at],
  });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.waitForTimeout(500);
  const byHold = await entries();
  harness.check(
    byHold.map((e) => e.name).join("|") === "Import items|Export items" &&
      (await where()) === before,
    `${label}: a long press on the + opens the same menu and does not navigate (${JSON.stringify(byHold)})`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  harness.check(
    (await page.locator('[role="menu"]').count()) === 0,
    `${label}: Escape closes the Add menu`,
  );
  // The default is still one tap: the + goes to the editor.
  await page.locator(".fab__add").tap();
  await page.waitForTimeout(600);
  harness.check(
    (await where()).endsWith("/vault/new"),
    `${label}: a tap on the + opens the editor (${await where()})`,
  );
  await page.goBack();
  await page.waitForTimeout(500);
}
