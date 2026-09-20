/**
 * Cold-load geometry, not a screenshot: state pips cannot shift icon centers.
 *
 * Two arrangements, because a phone is not a narrow desktop. With room the
 * identity and keys glyphs are the strip — four keys with support and the bell
 * (Host is gone; Pages is complete without it — ADR 0128). A phone draws no
 * strip at all: a second full-width bar under the tab bar is a row of the
 * frame spent on things looked at rarely, so all of it sits behind the top
 * bar's one overflow key instead. The strip stays in the document (it holds
 * the seat the support mark portals into) but is not drawn, so everything
 * here measures the *visible* controls — counting hidden ones would let
 * either arrangement pass for the other.
 */
export async function checkStatusline(page, check) {
  const original = page.viewportSize();
  // 320 is in the list because that is where the strip used to fold onto a
  // second row when it held seven keys. Checking 390 alone never saw it.
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
        const buttons = [...footer.querySelectorAll("button")]
          .filter((button) => button.getClientRects().length > 0)
          .map((button) => {
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
          });
        return {
          buttons,
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

/**
 * The arrangement at one width. On a phone: no strip drawn, and one overflow
 * key in the top bar holding what it held. With room: four keys, and
 * everything that must hold of them — equal boxes, centred glyphs, one axis,
 * one left-aligned strip, one styling, one Support, no widened document.
 */
function checkArrangement(geometry, width, check) {
  if (width < 900) {
    // No strip at all, and one key in the top bar carrying what it held.
    check(
      geometry.buttons.length === 0 && geometry.stripVisible === 0,
      `no statusline is drawn at ${width}px; its contents are behind one key`,
    );
    check(
      geometry.overflowKey === 1,
      "the top bar carries the overflow the strip rolled up into",
    );
    check(
      geometry.supportCount === 1 && geometry.footerCount === 1,
      "one Support control in one statusline on cold load",
    );
    check(!geometry.overflow, "footer does not widen the document");
    return;
  }
  const size = 28;
  check(
    geometry.buttons.length === 4,
    `footer has 4 visible controls at ${width}px; lock belongs with the profile`,
  );
  check(
    geometry.overflowKey === 0 && geometry.planesVisible === 1,
    "the connector glyphs are the strip where there is room for them",
  );
  check(
    geometry.buttons.every(
      (button) => button.width === size && button.height === size,
    ),
    "footer hit areas match",
  );
  check(
    geometry.buttons.every(
      (button) =>
        button.iconCenter !== null &&
        Math.abs(button.center - button.iconCenter) < 0.6,
    ),
    "all footer glyphs are centered despite status pips",
  );
  check(
    geometry.buttons.every(
      (button) => Math.abs(button.center - geometry.buttons[0].center) < 0.6,
    ),
    "footer controls share one vertical axis",
  );
  check(
    Math.abs(geometry.buttons[0].left - geometry.start) < 0.6 &&
      geometry.buttons.every((button, index, buttons) => {
        if (index === 0) return true;
        const gap = button.left - buttons[index - 1].right;
        return gap >= 0 && gap <= 8;
      }),
    "all footer controls form one left-aligned strip without a right-pushed group",
  );
  check(
    new Set(
      geometry.buttons.map(
        ({ background, border, radius }) => `${background}/${border}/${radius}`,
      ),
    ).size === 1,
    "footer controls share surface and border styling",
  );
  check(
    geometry.supportCount === 1 && geometry.footerCount === 1,
    "one Support control in one statusline on cold load",
  );
  check(!geometry.overflow, "footer does not widen the document");
}

async function checkProfileLock(page, check, width) {
  const prompt = page.locator(
    width > 900 ? ".rail .rail__prompt" : ".topbar .rail__prompt",
  );
  const lockBox = await prompt
    .getByRole("button", { name: "Lock vault" })
    .boundingBox();
  const vaultBox = await prompt.locator(".project-switcher").boundingBox();
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) === 1 &&
      lockBox &&
      vaultBox &&
      lockBox.x >= vaultBox.x + vaultBox.width &&
      lockBox.x - vaultBox.x - vaultBox.width <= 24 &&
      Math.abs(
        lockBox.y + lockBox.height / 2 - vaultBox.y - vaultBox.height / 2,
      ) < 1,
    `one visible lock beside the vault switcher at ${width}px`,
  );
}
