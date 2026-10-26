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
  const codeField = page.getByLabel("Code", { exact: true });
  if (code) {
    await tabTo(page, codeField);
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
