/**
 * The footer carries Support and the command field on every viewport. Session,
 * install and notification controls belong to the full-width header above the
 * panes. Measure actual controls after resizing, rather than hidden twins.
 */
export async function checkStatusline(page, check) {
  const original = page.viewportSize();
  // 320 is in the list because that is where a strip with too many keys folds
  // onto a second row. Checking 390 alone never saw it.
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await checkProfileLock(page, check, viewport.width);
    const geometry = await page
      .locator("footer.statusline")
      .evaluate((footer) => {
        const measure = (button) => {
          const box = button.getBoundingClientRect();
          const icon = button.querySelector("svg")?.getBoundingClientRect();
          const css = getComputedStyle(button);
          return {
            left: box.left,
            right: box.right,
            width: box.width,
            height: box.height,
            center: box.y + box.height / 2,
            iconCenter: icon ? icon.y + icon.height / 2 : null,
            background: css.backgroundColor,
            border: css.borderWidth,
            radius: css.borderRadius,
          };
        };
        const visible = [...footer.querySelectorAll("button")].filter(
          (button) => button.getClientRects().length > 0,
        );
        const command = footer.querySelector(".statusline__command");
        const commandSet = new Set(
          command ? [...command.querySelectorAll("button")] : [],
        );
        const keys = visible
          .filter((button) => !commandSet.has(button))
          .map(measure);
        const commandButtons = visible
          .filter((button) => commandSet.has(button))
          .map(measure);
        return {
          keys,
          commandButtons,
          start:
            footer.getBoundingClientRect().left +
            Number.parseFloat(getComputedStyle(footer).paddingLeft),
          supportCount: document.querySelectorAll(
            'button[aria-label="Support"]',
          ).length,
          overflowKey: [...document.querySelectorAll(".topbar__more")].filter(
            (button) => button.getClientRects().length > 0,
          ).length,
          stripVisible: [
            ...document.querySelectorAll("footer.statusline"),
          ].filter((el) => el.getClientRects().length > 0).length,
          headerBells: [
            ...document.querySelectorAll(
              '.app-header button[aria-label^="Notifications —"]',
            ),
          ].filter((button) => button.getClientRects().length > 0).length,
          planesVisible: [
            ...document.querySelectorAll(".statusline__planes"),
          ].filter((el) => el.getClientRects().length > 0).length,
          footerCount: document.querySelectorAll("footer.statusline").length,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
    checkArrangement(geometry, viewport.width, check);
  }
  if (original) await page.setViewportSize(original);
}

/** The four keys sit on one line: a strip that folds onto a second row is out. */
function onOneAxis(controls) {
  return controls.every(
    (control) => Math.abs(control.center - controls[0].center) < 0.6,
  );
}

/** Support and Run stay aligned in the one footer row at every width. */
function checkArrangement(geometry, width, check) {
  const command = geometry.commandButtons;
  check(
    command.length === 1,
    `the command cluster holds Run alone at ${width}px`,
  );
  check(
    geometry.keys.length === 1 && geometry.planesVisible === 0,
    `Support is the only footer key at ${width}px`,
  );
  check(
    geometry.headerBells === 1,
    `one notification key is directly available in the header at ${width}px`,
  );
  check(
    geometry.overflowKey === (width <= 900 ? 1 : 0),
    `the narrow layout keeps one overflow key at ${width}px`,
  );
  check(
    onOneAxis([...geometry.keys, ...command]),
    `the footer never folds at ${width}px`,
  );
  if (geometry.keys[0]) {
    check(
      Math.abs(geometry.keys[0].left - geometry.start) < 0.6,
      `Support sits at the footer start at ${width}px`,
    );
    check(
      geometry.keys[0].iconCenter !== null &&
        Math.abs(geometry.keys[0].center - geometry.keys[0].iconCenter) < 0.6,
      `Support glyph remains centered at ${width}px`,
    );
  }
  check(
    geometry.supportCount === 1 && geometry.footerCount === 1,
    `one Support control in one footer at ${width}px`,
  );
  check(!geometry.overflow, `footer does not widen the document at ${width}px`);
}

async function checkProfileLock(page, check, width) {
  const prompt = page.locator(".app-header .rail__prompt");
  const [promptBox, lockBox, accountBox] = await Promise.all([
    prompt.boundingBox(),
    prompt.getByRole("button", { name: "Lock vault" }).boundingBox(),
    prompt.locator(".account-switcher").boundingBox(),
  ]);
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) === 1 &&
      promptBox &&
      lockBox &&
      accountBox &&
      lockBox.x >= accountBox.x + accountBox.width &&
      (width <= 900 || lockBox.x - accountBox.x - accountBox.width <= 32) &&
      lockBox.y >= promptBox.y - 1 &&
      lockBox.y + lockBox.height <= promptBox.y + promptBox.height + 1 &&
      Math.abs(
        lockBox.y + lockBox.height / 2 - accountBox.y - accountBox.height / 2,
      ) < 1,
    `one visible lock follows the vault@account identity at ${width}px`,
  );
  if (width <= 900 && lockBox) {
    check(
      lockBox.width >= 44 && lockBox.height >= 44,
      `the header lock retains its touch target at ${width}px`,
    );
  }
}
