/** The pane owns its footer; only the item area scrolls. */
export async function checkVaultPane(page, check) {
  const original = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await page.locator(".vault__list").evaluate((pane) => {
      const status = pane.querySelector(".vault__status");
      const rows = pane.querySelector(".vtree__rows");
      const bottom = status.getBoundingClientRect().bottom;
      const scrollTop = rows.scrollTop;
      rows.scrollTop = rows.scrollHeight;
      const afterScroll = status.getBoundingClientRect().bottom;
      rows.scrollTop = scrollTop;
      return {
        bottom,
        afterScroll,
        paneBottom: pane.getBoundingClientRect().bottom,
      };
    });
    check(
      Math.abs(geometry.bottom - geometry.paneBottom) < 0.6,
      `vault status stays at the pane bottom at ${width}px`,
    );
    check(
      geometry.bottom === geometry.afterScroll,
      "scrolling vault items does not move the status row",
    );
  }
  if (original) await page.setViewportSize(original);
}
