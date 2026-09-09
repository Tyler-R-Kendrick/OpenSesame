/** Cold-load geometry, not a screenshot: state pips cannot shift icon centers. */
export async function checkStatusline(page, check) {
  const original = page.viewportSize();
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const geometry = await page
      .locator("footer.statusline")
      .evaluate((footer) => {
        const buttons = [...footer.querySelectorAll("button")].map((button) => {
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
          footerCount: document.querySelectorAll("footer.statusline").length,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
    const size = viewport.width < 900 ? 44 : 28;
    check(
      geometry.buttons.length === 8,
      `footer has eight controls at ${viewport.width}px`,
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
          ({ background, border, radius }) =>
            `${background}/${border}/${radius}`,
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
  if (original) await page.setViewportSize(original);
}
