/** WAL-B20 — measure Wallet .btn controls at 390px. */

export async function measureWalletButtons(page) {
  return page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(".section .btn, .panel .btn, .panel button"),
    ];
    return nodes
      .map((node) => {
        const box = node.getBoundingClientRect();
        if (box.height <= 0 || box.width <= 0) return null;
        return { h: box.height };
      })
      .filter((row) => row !== null);
  });
}

export function walletButtonsMeetTouchFloor(sizes) {
  return sizes.length > 0 && sizes.every((row) => row.h >= 44);
}

export async function runWalB20NarrowWallet(page, check) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Budgets" }).first().click();
  await page.waitForTimeout(400);
  const sizes = await measureWalletButtons(page);
  check(sizes.length > 0, "WAL-B20: Wallet has visible controls at 390px");
  check(
    walletButtonsMeetTouchFloor(sizes),
    "WAL-B20: visible Wallet .btn controls are at least 44px at 390px",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
}
