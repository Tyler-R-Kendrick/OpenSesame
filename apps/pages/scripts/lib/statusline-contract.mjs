/**
 * Cold-load geometry, not a screenshot: state pips cannot shift icon centers.
 *
 * Two arrangements, because a phone is not a narrow desktop. With room the
 * five connector glyphs are the strip — seven keys with support and the bell.
 * On a phone they roll up into the overflow key, which carries the aggregate
 * pip: three keys. Both sets are always in the document, one hidden by a media
 * query, so everything here measures the *visible* controls — counting hidden
 * ones would let either arrangement pass for the other.
 */
export async function checkStatusline(page, check) {
  const original = page.viewportSize();
  // 320 is in the list because that is where the strip used to fold onto a
  // second row: seven 44px keys are 308px, and every pixel of gutter above
  // that wrapped one of them. Checking 390 alone never saw it.
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
          overflowKey: [
            ...document.querySelectorAll(".statusline__more > button"),
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

/**
 * The arrangement at one width. Seven keys with room, three on a phone, and
 * everything that must hold of either: equal boxes, centred glyphs, one axis,
 * one left-aligned strip, one styling, one Support, no widened document.
 */
function checkArrangement(geometry, width, check) {
  const phone = width < 900;
  const size = phone ? 44 : 28;
  // Seven with room (support, five connector glyphs, the bell); three on a
  // phone (support, the bell, the overflow the glyphs rolled up into).
  const expected = phone ? 3 : 7;
  check(
    geometry.buttons.length === expected,
    `footer has ${expected} visible controls at ${width}px; lock belongs with the profile`,
  );
  check(
    geometry.overflowKey === (phone ? 1 : 0) &&
      geometry.planesVisible === (phone ? 0 : 1),
    phone
      ? "the connector glyphs roll up into one overflow key on a phone"
      : "the connector glyphs are the strip where there is room for them",
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
