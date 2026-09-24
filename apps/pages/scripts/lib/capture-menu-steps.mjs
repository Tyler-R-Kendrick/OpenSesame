/**
 * Capture verbs for context menus, hidden items and settings files — the
 * steps a menu journey takes, kept beside `capture-evidence.mjs`'s own.
 * `press` is that script's tap-or-click, so a phone capture taps.
 */
export function menuSteps({ press }) {
  return {
    rightClick,
    hold,
    menuOptional,
    openSettingsFile: (page, category) =>
      openSettingsFile(page, category, press),
    measure,
  };
}

/** Right-click a rail row, the way a person asks a row what it can do. */
async function rightClick(page, text) {
  const row = page.locator(".railtree__row", { hasText: text }).first();
  if ((await row.count()) === 0)
    throw new Error(
      `capture-evidence rightClick("${text}"): no rail row matched — refusing a silent miss`,
    );
  await row.click({ button: "right" });
  await page.waitForTimeout(500);
}

/**
 * Hold a finger still on the first element matching `selector` — real CDP
 * touch events, the same the touch gate uses — then lift it.
 */
async function hold(page, selector) {
  const target = page.locator(selector).first();
  const box = await target.boundingBox();
  if (!box)
    throw new Error(
      `capture-evidence hold("${selector}"): nothing to hold — refusing a silent miss`,
    );
  const point = {
    x: Math.round(box.x + Math.min(box.width / 2, 48)),
    y: Math.round(box.y + box.height / 2),
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  await page.waitForTimeout(700);
}

/** Pick a context-menu entry when this build has one (a base may not). */
async function menuOptional(page, name) {
  const entry = page
    .locator('[role="menu"] [role^="menuitem"]')
    .filter({ hasText: name })
    .first();
  if (await entry.count()) {
    await entry.click();
    await page.waitForTimeout(900);
  }
}

/**
 * Open the General settings file by whichever road this build has: the
 * base's YAML key on the section head, or the branch's command-bar path.
 */
async function openSettingsFile(page, category, press) {
  if (await page.locator(".set-raw").count()) return;
  const yaml = page.getByRole("button", { name: "YAML", exact: true });
  if (await yaml.count()) {
    await press(yaml);
  } else {
    await page
      .locator("#command-bar-input")
      .fill(`settings/${category}/config.yaml`);
    await page.keyboard.press("Enter");
  }
  await page.locator(".set-raw").waitFor({ timeout: 8000 });
  await page.waitForTimeout(700);
}

/** Log what the browser measures, so each caption quotes a number. */
async function measure(page, name) {
  const facts = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".railtree__row")];
    const items = [...document.querySelectorAll(".ctxmenu__item")];
    return {
      railRows: rows.length,
      trashRow: rows.some((row) =>
        row.getAttribute("href")?.endsWith("?f=trash"),
      ),
      configRows: rows.filter((row) => row.textContent?.includes("config.yaml"))
        .length,
      viewToggleKeys: document.querySelectorAll(".section__head .set__view-btn")
        .length,
      menuEntries: items.length,
      menuMode: document.querySelector(".ctxmenu--sheet")
        ? "sheet"
        : document.querySelector(".ctxmenu")
          ? "popover"
          : "none",
      menuCoversRow: (() => {
        const menu = document
          .querySelector(".ctxmenu")
          ?.getBoundingClientRect();
        const row = document
          .querySelector(".vtree__row")
          ?.getBoundingClientRect();
        if (!menu || !row) return null;
        return !(menu.bottom <= row.top || menu.top >= row.bottom);
      })(),
      url: location.pathname + location.search,
      menuEntryHeights: [
        ...new Set(
          items.map((item) => Math.round(item.getBoundingClientRect().height)),
        ),
      ],
      file: document.querySelector(".set-raw__path")?.textContent ?? null,
    };
  });
  console.log(`  measure ${name}: ${JSON.stringify(facts)}`);
}
