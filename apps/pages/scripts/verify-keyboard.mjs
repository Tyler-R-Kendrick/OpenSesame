import { fileURLToPath } from "node:url";
// Real keyboard input only: no click(), focus(), or synthetic keydown setup.
import { expect } from "@playwright/test";
import { approveByKeyboard } from "./lib/capability-keyboard-contract.mjs";
import { contextMenuKeyboardContract } from "./lib/context-menu-keyboard-contract.mjs";
import { liveKeyboardContract } from "./lib/live-keyboard-contract.mjs";
import { localDirectoryContract } from "./lib/local-directory-contract.mjs";
import { navigationTreeContract } from "./lib/navigation-tree-contract.mjs";
import { settingsFileKeyboardContract } from "./lib/settings-file-keyboard-contract.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { trustedContactsKeyboardContract } from "./lib/trusted-contacts-keyboard-contract.mjs";

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

/**
 * The local-only seal is a sign-in road, and sign-in comes after the door's
 * setup road (ADR 0150 §1): Enter on Set up, Skip all, then the seal.
 */
async function toLocalSeal(page) {
  await expect(
    page.getByRole("button", { name: "Set up your own" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Skip all" }));
  await page.keyboard.press("Enter");
  await tabTo(
    page,
    page.getByRole("button", { name: "Use without an account" }),
  );
  await page.keyboard.press("Enter");
}

/**
 * A phone opens the vault on its section tree, with the keyboard on it (the
 * rail's own tree, drawn in the buffer). Enter on its cursor — "all" — is the
 * way in to the list, where the desktop already is.
 */
async function intoTheList(page, width) {
  // Sealing or creating a guest vault derives keys asynchronously. Await the
  // mounted vault before checking where its own focus effect lands.
  await expect(page.locator(".vault")).toBeVisible({ timeout: 30_000 });
  if (width === 1280) return;

  await expect(page.locator(".railtree")).toBeFocused();
  await page.keyboard.press("Enter");
}

async function savedVaultUnlock(width) {
  const { page, context } = await harness.newPage(browser);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await toLocalSeal(page);
  // A new vault is sealed with a passkey or a PIN, never a password (ADR 0180).
  await tabTo(page, page.getByRole("tab", { name: "PIN", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Device PIN", { exact: true })).toBeFocused();
  const pin = "48291037";
  await page.keyboard.insertText(pin);
  await tabTo(page, page.getByLabel("Confirm PIN", { exact: true }));
  await page.keyboard.insertText(pin);
  const acknowledge = page.getByRole("checkbox");
  await tabTo(page, acknowledge);
  await page.keyboard.press("Space");
  await expect(acknowledge).toBeChecked();
  const seal = page.getByRole("button", {
    name: "Seal with PIN",
    exact: true,
  });
  await expect(seal).toBeEnabled();
  await tabTo(page, seal);
  await page.keyboard.press("Enter");
  const create = page.getByRole("link", { name: "New item", exact: true });
  await intoTheList(page, width);
  await expect(create).toBeFocused();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByLabel("PIN", { exact: true })).toBeFocused();
  await page.keyboard.insertText(pin);
  await page.keyboard.press("Enter");
  // The reload kept the address, which is already the list.
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
    `PASS ${width}px: saved vault reload, unlock and immediate navigation`,
  );
}

try {
  for (const width of [1280, 390]) {
    await savedVaultUnlock(width);
    const { page, context } = await harness.newPage(browser);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    // The front door lands on Set up; Tab reaches Join a session, and the
    // corner Skip — the door's guest road — sits before both (ADR 0150 §1).
    await expect(
      page.getByRole("button", { name: "Set up your own" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Join a session" }),
    ).toBeFocused();
    // The help key sits in the card's corner row, after the roads in Tab order
    // (ADR 0166): Tab reaches it, Enter opens the Support sheet, and Escape
    // closes it with the focus back on the key. It never held the focus on
    // arrival — the door landed on Set up above.
    const help = page.getByRole("button", { name: "Support", exact: true });
    // Guided help is an asynchronously loaded module; wait for its key before
    // testing Tab order, without moving focus or changing the keymap.
    await expect(help).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(help).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Support", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Support", exact: true }),
    ).toHaveCount(0);
    await expect(help).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.getByRole("button", { name: "Skip sign-in and continue as guest" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const create = page.getByRole("link", { name: "New item", exact: true });
    await intoTheList(page, width);
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
      // A directory starts open only when the shell mounted on it, and the
      // capability walk above remounted it on Settings: open vault/ the way a
      // person does, with the cursor on it.
      const vaultRow = rail.locator('[aria-expanded="false"]', {
        hasText: /^vault\//,
      });
      if (await vaultRow.count()) await page.keyboard.press("ArrowRight");
      // The first stop is the section's own listing (the page already shown),
      // the second previews the favorites filter.
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
    // Live sessions (ADR 0150): every swap between the form, the request code,
    // the joined view and the ended one leaves the keyboard on a control.
    await liveKeyboardContract({ harness, origin, base, width, tabTo });
    // Settings' files: the stage draws the one focus cue a painted textarea has.
    await settingsFileKeyboardContract({
      harness,
      browser,
      origin,
      base,
      width,
    });
    // Trusted contacts (ADR 0187): the tab, its five sheets, focus in and back.
    await trustedContactsKeyboardContract({
      harness,
      browser,
      origin,
      base,
      width,
      tabTo,
    });
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
