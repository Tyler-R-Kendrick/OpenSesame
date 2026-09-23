import { fileURLToPath } from "node:url";
// Real keyboard input only: no click(), focus(), or synthetic keydown setup.
import { expect } from "@playwright/test";
import { approveByKeyboard } from "./lib/capability-keyboard-contract.mjs";
import { contextMenuKeyboardContract } from "./lib/context-menu-keyboard-contract.mjs";
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
  for (let step = 0; step < 160; step++) {
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
    // The front door lands on Set up; Tab walks the corner skip, the
    // broker's mark and guest, in order. Join is invite-link only now.
    await expect(
      page.getByRole("button", { name: "Set up your own" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Skip sign-in and continue as guest" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
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
    // The shell's status chrome, wherever this width draws it: with room the
    // statusline's bell, and on a phone the top bar's overflow — there is no
    // statusline there, so the bell is inside the sheet that key opens.
    const chromeKey =
      width === 1280
        ? page.getByRole("button", { name: /^Notifications/ })
        : page.getByRole("button", { name: /^More —/ });

    // The sections below belong to capabilities, so this device has to
    // choose them first — by keyboard, like everything else here.
    await approveByKeyboard(page, tabTo, [
      "External connectors",
      "Access authority",
      "Browser-local IAM",
      // People, agents and the organization are this capability's views; the
      // identity tree and the local-directory walk below are its surface.
      "Directory provisioning",
    ]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("g");
    await page.keyboard.press("v");
    await expect(page).toHaveURL(/\/vault\/?(\?|$)/);
    console.log(
      `PASS ${width}px: capabilities are chosen with the keyboard alone`,
    );
    if (width !== 1280) {
      // Sections are behind one key on a phone, so that key is navigation and
      // has to answer the keyboard: Tab reaches it, Enter opens the drawer,
      // focus lands inside, Escape closes it and hands the key back.
      const sections = page.getByRole("button", { name: "Sections" });
      await tabTo(page, sections);
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog", { name: "Sections" });
      await expect(drawer).toBeVisible();
      await expect(page.locator(":focus")).toHaveCount(1);
      await expect(drawer.locator(":focus")).toHaveCount(1);
      await tabTo(page, drawer.getByRole("link", { name: "Connections" }));
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(sections).toBeFocused();
      console.log(`PASS ${width}px: the sections drawer answers the keyboard`);
    }
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
      // The section arrives open: the first stop is its own listing (the page
      // already shown), the second previews the favorites filter.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(page).not.toHaveURL(before);
      await expect(rail).toBeFocused();
      await contextMenuKeyboardContract(page);
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
      // A second Escape leaves any text field that stole focus after the
      // previous section's chrome pass (mobile access has denser stops).
      await page.keyboard.press("Escape");
      await page.keyboard.press("g");
      await page.keyboard.press(key);
      await expect(page).toHaveURL(new RegExp(`/${section}(?:[/?].*)?$`), {
        timeout: 10_000,
      });
      await expect(page.locator("main")).toBeVisible();
      if (width === 390 && section === "identity")
        await localDirectoryContract(page, tabTo);
      await tabTo(page, chromeKey);
      console.log(
        `PASS ${width}px: keyboard reaches ${section} and its status chrome`,
      );
    }
    if (width === 1280) await navigationTreeContract(page, tabTo);
    await expect(chromeKey).toBeFocused();
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
    await expect(chromeKey).toBeFocused();
    const lock = page
      .getByRole("button", { name: "Lock vault", exact: true })
      .filter({ visible: true });
    await tabTo(page, lock);
    await page.keyboard.press("Enter");
    // Guest lock keeps the guest tomb selected (guest resume); Unlock is the
    // road back, not another "Continue as guest" affordance.
    await expect(
      page.getByRole("button", { name: /^Unlock$/ }).first(),
    ).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByRole("button", { name: /^Unlock$/ }).first(),
    ).toBeFocused();
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
