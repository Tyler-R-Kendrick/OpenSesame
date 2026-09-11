import { fileURLToPath } from "node:url";
// Real keyboard input only: no click(), focus(), or synthetic keydown setup.
import { expect } from "@playwright/test";
import { localDirectoryContract } from "./lib/local-directory-contract.mjs";
import { navigationTreeContract } from "./lib/navigation-tree-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const harness = createHarness({
  dist: fileURLToPath(new URL("../dist", import.meta.url)),
  origin,
  base,
  out: "/tmp/opensesame-keyboard-verification",
});
const browser = await harness.launch();

async function tabTo(page, target, key = "Tab") {
  for (let step = 0; step < 80; step++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press(key);
  }
  throw new Error(
    `${key} cannot reach ${await target.getAttribute("aria-label")}`,
  );
}

async function savedVaultUnlock(width) {
  const { page, context } = await harness.newPage(browser);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await tabTo(
    page,
    page.getByRole("button", { name: "Use without an account" }),
  );
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("tab", { name: "Password", exact: true }));
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Master password", { exact: true }),
  ).toBeFocused();
  const password = "Cedar-lantern-47-river!";
  await page.keyboard.insertText(password);
  await tabTo(
    page,
    page.getByLabel("Confirm master password", { exact: true }),
  );
  await page.keyboard.insertText(password);
  const acknowledge = page.getByRole("checkbox");
  await tabTo(page, acknowledge);
  await page.keyboard.press("Space");
  await expect(acknowledge).toBeChecked();
  const seal = page.getByRole("button", {
    name: "Seal this device",
    exact: true,
  });
  await expect(seal).toBeEnabled();
  await tabTo(page, seal);
  await page.keyboard.press("Enter");
  const create = page.getByRole("link", { name: "New item", exact: true });
  await expect(create).toBeFocused();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.insertText(password);
  await page.keyboard.press("Enter");
  await expect(create).toBeFocused();
  if (width === 1280) {
    const before = page.url();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".railtree")).toBeFocused();
    await expect(page).not.toHaveURL(before);
    await page.keyboard.press("n");
  } else {
    await page.keyboard.press("Enter");
  }
  await expect(page.locator("form.editor")).toBeVisible();
  await context.close();
  console.log(
    `PASS ${width}px: saved password vault reload, unlock and immediate navigation`,
  );
}

try {
  for (const width of [1280, 390]) {
    await savedVaultUnlock(width);
    const { page, context } = await harness.newPage(browser);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await expect(
      page.getByRole("button", { name: "Continue with Google" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Continue as guest", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const create = page.getByRole("link", { name: "New item", exact: true });
    await expect(create).toBeFocused();
    if (width === 1280) {
      const before = page.url();
      await page.keyboard.press("ArrowDown");
      await expect(page.locator(".railtree")).toBeFocused();
      await expect(page).not.toHaveURL(before);
      await page.keyboard.press("g");
      await page.keyboard.press("v");
      await expect(page).toHaveURL(/\/vault\/?(\?|$)/);
      await expect(create).toBeVisible();
      await tabTo(page, create);
    }
    await page.keyboard.press("Enter");
    const form = page.locator("form.editor");
    await expect(form).toBeVisible();
    await tabTo(page, page.getByLabel("Name", { exact: true }));
    await page.keyboard.press("Escape");
    await expect(page.locator(".vault__detail")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await tabTo(page, create);
    await page.keyboard.press("Enter");
    await expect(form).toBeVisible();
    const cancel = form.getByRole("link", { name: "Cancel", exact: true });
    await tabTo(page, cancel);
    await page.keyboard.press("Enter");
    await expect(form).toHaveCount(0);
    await page.keyboard.press("n");
    await expect(form).toBeVisible();
    await tabTo(page, page.getByLabel("Name", { exact: true }));
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("Keyboard regression fixture");
    await tabTo(
      page,
      form.getByRole("button", { name: "Save item", exact: true }),
    );
    await page.keyboard.press("Enter");
    await expect(form).toHaveCount(0);
    await page.keyboard.press("g");
    await page.keyboard.press("v");
    await expect(page).toHaveURL(/\/vault$/);
    if (width === 1280) {
      const items = page.locator(".vtree__rows");
      const rail = page.locator(".railtree");
      await tabTo(page, items);
      await page.keyboard.press("F6");
      await expect(rail).toBeFocused();
      await page.keyboard.press("F6");
      await expect(items).toBeFocused();
      await tabTo(page, rail, "Shift+Tab");
      const before = page.url();
      await page.keyboard.press("ArrowDown");
      await expect(page).not.toHaveURL(before);
      await expect(rail).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(rail).not.toBeFocused();
    }
    for (const [key, section] of [
      ["c", "connections"],
      ["a", "access"],
      ["i", "identity"],
      ["s", "settings"],
    ]) {
      await page.keyboard.press("Escape");
      await page.keyboard.press("g");
      await page.keyboard.press(key);
      await expect(page).toHaveURL(new RegExp(`/${section}(?:[/?].*)?$`));
      await expect(page.locator("main")).toBeVisible();
      if (width === 390 && section === "identity")
        await localDirectoryContract(page, tabTo);
      await tabTo(page, page.getByRole("button", { name: /^Notifications/ }));
      console.log(
        `PASS ${width}px: keyboard reaches ${section} and its status bar`,
      );
    }
    if (width === 1280) await navigationTreeContract(page, tabTo);
    const notices = page.getByRole("button", { name: /^Notifications/ });
    await expect(notices).toBeFocused();
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeFocused();
    for (const key of ["Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      await expect(close).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(notices).toBeFocused();
    const lock = page
      .getByRole("button", { name: "Lock vault", exact: true })
      .filter({ visible: true });
    await tabTo(page, lock);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Continue as guest", exact: true }),
    ).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator(":focus")).not.toHaveJSProperty(
      "tagName",
      "BODY",
    );
    await context.close();
    console.log(
      `PASS keyboard-only load, guest, New, Escape, Cancel, lock/reload (${width}px)`,
    );
  }
} finally {
  await browser.close();
}
if (
  harness.failures.length ||
  harness.log.some(
    (entry) => entry.kind === "PAGE-ERROR" || entry.kind === "LOOPBACK-REQUEST",
  )
) {
  throw new Error("Keyboard journey reported browser errors");
}
