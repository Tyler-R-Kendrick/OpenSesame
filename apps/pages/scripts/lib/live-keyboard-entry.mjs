/** The current owner seal and joiner-local-vault ceremonies, using only keys. */
import { expect } from "@playwright/test";

const PIN = "48291037";

export async function sealLiveKeyboardOwner(page, tabTo, width) {
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
  await tabTo(page, page.getByRole("tab", { name: "PIN", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Device PIN", { exact: true })).toBeFocused();
  await page.keyboard.insertText(PIN);
  await tabTo(page, page.getByLabel("Confirm PIN", { exact: true }));
  await page.keyboard.insertText(PIN);
  const consent = page.getByRole("checkbox", {
    name: "I understand this vault cannot be recovered.",
    exact: true,
  });
  await tabTo(page, consent);
  await page.keyboard.press("Space");
  await expect(consent).toBeChecked();
  const seal = page.getByRole("button", { name: "Seal with PIN", exact: true });
  await expect(seal).toBeEnabled();
  await tabTo(page, seal);
  await page.keyboard.press("Enter");
  await expect(page.locator(".vault")).toBeVisible({ timeout: 30_000 });
  if (width !== 1280) {
    await expect(page.locator(".railtree")).toBeFocused();
    await page.keyboard.press("Enter");
  }
}

export async function prepareLiveKeyboardJoiner(page, tabTo) {
  await tabTo(page, page.getByLabel("Your vault PIN", { exact: true }));
  await page.keyboard.insertText(PIN);
  await tabTo(page, page.getByLabel("Confirm PIN", { exact: true }));
  await page.keyboard.insertText(PIN);
  const consent = page.getByRole("checkbox", {
    name: "I understand this vault cannot be recovered.",
    exact: true,
  });
  await tabTo(page, consent);
  await page.keyboard.press("Space");
  await expect(consent).toBeChecked();
}

/** The joiner opens the link, fills the form and asks; the request code. */
export async function joinerAsks(page, { link, code, tabTo, focusIn }) {
  await page.goto(link, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Join a session" }),
  ).toBeVisible({ timeout: 20_000 });
  // A device that has not chosen Live sessions is asked first (ADR 0130).
  const apply = page.getByRole("button", { name: "Apply configuration" });
  if (await apply.isVisible().catch(() => false)) {
    await tabTo(page, apply);
    await page.keyboard.press("Enter");
  }
  // The form draws once the link is read (and the configuration applied):
  // wait for it before asking whether it has a code field, as the pointer
  // walk does, or an invite's Code is skipped and Ask to join stays disabled.
  await page.getByLabel("Your name").waitFor({ timeout: 20_000 });
  if (code) {
    await tabTo(page, page.getByLabel("Code", { exact: true }));
    await page.keyboard.insertText(code.toLowerCase());
  }
  await tabTo(page, page.getByLabel("Your name"));
  await page.keyboard.insertText("Ada Lovelace");
  await prepareLiveKeyboardJoiner(page, tabTo);
  await tabTo(
    page,
    page.getByRole("button", { name: "Ask to join", exact: true }),
  );
  await page.keyboard.press("Enter");
  const copy = page.getByRole("button", { name: "Copy your join request" });
  // A join request waits on this browser's ICE gathering.
  await expect(copy, "asking lands on the request code").toBeFocused({
    timeout: 20_000,
  });
  await focusIn(page, ".live-join", "after asking");
  await page.keyboard.press("Enter");
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * The owner names this machine in Routes, by keyboard (ADR 0150 §6): the
 * walk's two browsers share it, and loopback is a route only when named.
 */
export async function namesThisMachine(page, panel, tabTo) {
  const advanced = panel.locator("details.live-advanced");
  if ((await advanced.getAttribute("open")) === null) {
    await tabTo(page, advanced.locator("summary"));
    await page.keyboard.press("Enter");
  }
  await tabTo(page, panel.getByLabel("Tailnet, VPN or LAN address"));
  await page.keyboard.insertText("127.0.0.1");
  await page.keyboard.press("Enter");
  await expect(
    panel.locator("#live-routes").getByText("127.0.0.1", { exact: true }),
  ).toBeVisible();
}

/**
 * The owner's reply named that address: the keyboard lands on Allow, and
 * Enter allows it (ADR 0150 §6, amended 2026-10-24).
 */
export async function allowsByKeyboard(page) {
  const allow = page.getByRole("button", {
    name: "Allow the owner's addresses",
    exact: true,
  });
  await expect(allow, "the owner's addresses land on Allow").toBeFocused({
    timeout: 20_000,
  });
  await page.keyboard.press("Enter");
}
