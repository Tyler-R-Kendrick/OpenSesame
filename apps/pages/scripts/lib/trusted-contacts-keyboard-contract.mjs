// Settings › Trusted contacts walked with the keyboard alone (ADR 0187 + the
// keyboard contract in AGENTS.md §5).
//
// Guest, decoy and locked vaults draw no panel, so the walk starts from the
// door the way a person does — Enter on Set up, Skip all, the local seal, a PIN
// — and switches the capability on from Settings › Features. After that
// every claim is about where the keyboard is:
//   - the tab is reached by `g s` and Tab, and it leaves the key in reading
//     order: Start a circle;
//   - a sheet opens with the keyboard on its close key, Tab and Shift+Tab stay
//     inside it, Escape closes it and gives the keyboard back to the key that
//     opened it;
//   - the circle's name takes typing, and with no contact chosen its commit
//     key stays off and Enter keeps the sheet open with the keyboard in it.
//
// Every step is a real key press. Nothing is clicked, focused or dispatched;
// the only `evaluate` calls read the page, as a person would.

import { expect } from "@playwright/test";
import { approveByKeyboard } from "./capability-keyboard-contract.mjs";
import { focusIn } from "./live-keyboard-contract.mjs";

const PIN = "48291037";

const KEYS = ["Start a circle"];

/** Set up, Skip all, then the local seal: the door's road to a vault of one's own. */
async function toLocalSeal(page, tabTo) {
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

/** A vault sealed with a PIN, typed; a phone then opens its list on Enter. */
async function sealByKeyboard(page, tabTo, width) {
  await toLocalSeal(page, tabTo);
  await tabTo(page, page.getByRole("tab", { name: "PIN", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Device PIN", { exact: true })).toBeFocused();
  await page.keyboard.insertText(PIN);
  await tabTo(page, page.getByLabel("Confirm PIN", { exact: true }));
  await page.keyboard.insertText(PIN);
  const acknowledge = page.getByRole("checkbox");
  await tabTo(page, acknowledge);
  await page.keyboard.press("Space");
  await expect(acknowledge).toBeChecked();
  const seal = page.getByRole("button", { name: "Seal with PIN", exact: true });
  await tabTo(page, seal);
  await page.keyboard.press("Enter");
  await expect(page.locator(".vault")).toBeVisible({ timeout: 30_000 });
  if (width !== 1280) {
    await expect(page.locator(".railtree")).toBeFocused();
    await page.keyboard.press("Enter");
  }
}

/** Settings › Trusted contacts, by `g s` and Tab. */
async function openTab(page, tabTo) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/settings(?:[/?].*)?$/, { timeout: 10_000 });
  const security = page.getByRole("link", {
    name: "Security",
    exact: true,
  });
  await tabTo(page, security.first());
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/security(?:[?#].*)?$/, {
    timeout: 10_000,
  });
  // The subsection is part of Security now. The page index is a phone
  // control and is not drawn at this width, so the keyboard goes straight to
  // the first key the subsection contributes.
  await expect(page.locator("#trusted-contacts")).toBeVisible({
    timeout: 20_000,
  });
  for (const id of ["circles"])
    await expect(page.locator(`section#${id}`)).toBeVisible({
      timeout: 20_000,
    });
  await tabTo(
    page,
    page.getByRole("button", { name: "Start a circle", exact: true }),
  );
}

/** Where the keyboard is, in words a failure can quote. */
const focusedName = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el?.getAttribute("aria-label") || el?.id || el?.tagName || "";
  });

/** The keys sit in reading order: each one comes after the last in the document. */
async function keysInOrder(page, tabTo) {
  let previous = null;
  for (const name of KEYS) {
    const key = page.getByRole("button", { name, exact: true });
    await expect(key, `${name} is on the tab`).toHaveCount(1);
    await tabTo(page, key);
    const handle = await key.elementHandle();
    if (previous) {
      const after = await previous.evaluate(
        (a, b) => Boolean(a.compareDocumentPosition(b) & 4),
        handle,
      );
      expect(after, `${name} comes after the key before it`).toBe(true);
    }
    previous = handle;
  }
}

/** Tab and Shift+Tab never leave the open sheet, however many times they are pressed. */
async function sheetHoldsFocus(page, label) {
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let step = 0; step < 24; step++) {
      await page.keyboard.press(key);
      const inside = await page.evaluate(
        () => document.activeElement?.closest('[role="dialog"]') !== null,
      );
      expect(
        inside,
        `${label}: ${key} step ${step + 1} stays in the sheet`,
      ).toBe(true);
    }
  }
}

/** Open a sheet with Enter, check where the keyboard landed, run `inside`, Escape. */
async function sheet(page, tabTo, name, inside, title = name) {
  const key = page.getByRole("button", { name, exact: true });
  await tabTo(page, key);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog, `${name} opens`).toBeVisible();
  expect(
    await focusedName(page),
    `${name}: the close key holds the keyboard`,
  ).toBe("Close");
  await focusIn(page, '[role="dialog"]', `${name}: arrival`);
  await sheetHoldsFocus(page, name);
  if (inside) await inside(dialog);
  await page.keyboard.press("Escape");
  await expect(dialog, `${name} closes on Escape`).toHaveCount(0);
  await expect(
    key,
    `${name}: the key that opened it has the keyboard back`,
  ).toBeFocused();
}

/** A name typed; with no contact chosen, Enter saves nothing and the keyboard stays. */
async function newCircleStep(page, tabTo, dialog) {
  const name = dialog.getByLabel("Name", { exact: true });
  await tabTo(page, name);
  await page.keyboard.insertText("Family");
  await expect(name).toHaveValue(/Family$/);
  const save = dialog.getByRole("button", { name: "Save the circle" });
  await expect(
    save,
    "no contact chosen: the circle cannot be saved",
  ).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(dialog, "Enter with no contact keeps the sheet").toBeVisible();
  await focusIn(page, '[role="dialog"]', "the circle form keeps the keyboard");
  // Escape leaves the text field for its sheet before it closes the sheet.
  await page.keyboard.press("Escape");
  await expect(
    dialog,
    "Escape in the name leaves the field, not the sheet",
  ).toBeVisible();
  await focusIn(
    page,
    '[role="dialog"]',
    "Escape from the name stays in the sheet",
  );
}

export async function trustedContactsKeyboardContract({
  harness,
  browser,
  origin,
  base,
  width,
  tabTo,
}) {
  const before = harness.failures.length;
  const { page, context } = await harness.newPage(browser);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealByKeyboard(page, tabTo, width);
  await approveByKeyboard(page, tabTo, ["Trusted contacts"]);
  await openTab(page, tabTo);
  await expect(page.locator(":focus")).not.toHaveJSProperty("tagName", "BODY");
  await keysInOrder(page, tabTo);
  await sheet(
    page,
    tabTo,
    "Start a circle",
    (dialog) => newCircleStep(page, tabTo, dialog),
    "Trusted contacts",
  );
  // The hidden file input carries the key's name too, so the key is found by id.
  await context.close();
  if (harness.failures.length === before)
    console.log(
      `PASS ${width}px: Trusted contacts by keyboard — tab, key in order, one sheet, focus in and back`,
    );
}
