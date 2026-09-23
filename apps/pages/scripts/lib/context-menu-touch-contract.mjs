/**
 * The context menu under a finger (DESIGN.md § Touch).
 *
 * A real touch hold — CDP touch events, so the page sees `pointerType:
 * "touch"` and Chromium runs its own long-press detection too — must open
 * exactly one menu for the row it rests on, must not also tap the row when
 * the finger lifts, and must draw entries a finger can hit. The caller's
 * `audit` measures the open menu against the whole touch contract.
 */

async function hold(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("context-menu touch: nothing to hold");
  const x = Math.round(box.x + Math.min(box.width / 2, 48));
  const y = Math.round(box.y + box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  await page.waitForTimeout(400);
}

async function entryHeights(menu) {
  return menu
    .locator('[role^="menuitem"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().height)),
    );
}

export async function contextMenuTouchContract(
  page,
  stop,
  { harness, openTab, audit },
) {
  const label = stop("context-menu");
  const { check } = harness;
  await openTab(page, "Vault");
  const row = page.locator(".vtree__row").first();
  check((await row.count()) === 1, `${label}: a vault row to hold`);
  if ((await row.count()) === 0) return;
  const before = page.url();
  await hold(page, row);
  const menu = page.getByRole("menu");
  check((await menu.count()) === 1, `${label}: holding a row opens one menu`);
  check(page.url() === before, `${label}: the lift does not also open the row`);
  const heights = await entryHeights(menu);
  check(
    heights.length > 0 && heights.every((height) => height >= 44),
    `${label}: every menu entry is at least 44px (${heights.join(",")})`,
  );
  await audit(page, `${label}-row-menu`);
  await menu.getByRole("menuitem", { name: "Open", exact: true }).tap();
  await page.waitForTimeout(700);
  check((await menu.count()) === 0, `${label}: an entry closes the menu`);
  check(
    /\/vault\/[^/?]+/.test(new URL(page.url()).pathname),
    `${label}: Open opened the held row`,
  );

  await openTab(page, "Settings");
  const tab = page
    .locator(".set__nav")
    .getByRole("link", { name: "Security", exact: true });
  const settingsAt = page.url();
  await hold(page, tab);
  check(
    (await menu.getByRole("menuitem", { name: "Open config.yaml" }).count()) ===
      1,
    `${label}: holding a Settings tab offers its config.yaml`,
  );
  check(
    page.url() === settingsAt,
    `${label}: the lift does not also follow the tab`,
  );
  await menu.getByRole("menuitem", { name: "Open config.yaml" }).tap();
  await page.waitForTimeout(900);
  check(
    page.url().includes("/settings/security?file=config.yaml"),
    `${label}: the file opens from the held tab (${page.url()})`,
  );
  console.log(`PASS ${label}: context menu by touch`);
}
