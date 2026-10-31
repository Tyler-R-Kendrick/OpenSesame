/** The current owner seal and joiner-local-vault ceremonies, using only keys. */
import { expect } from "@playwright/test";
import { inLiveSession } from "./live-joined.mjs";
import { peerStates } from "./live-rtc.mjs";

const PIN = "48291037";

/** These two browsers share a machine; authorize its address through Routes. */
export async function nameKeyboardMachine(page, tabTo) {
  const panel = page.getByRole("dialog", {
    name: "Share personal",
    exact: true,
  });
  const advanced = panel.locator("summary").filter({ hasText: /^Advanced$/ });
  await tabTo(page, advanced);
  await page.keyboard.press("Enter");
  const field = panel.getByLabel("Tailnet, VPN or LAN address", {
    exact: true,
  });
  await tabTo(page, field);
  await page.keyboard.insertText("127.0.0.1");
  const add = panel.getByRole("button", {
    name: "Add the address",
    exact: true,
  });
  await expect(add).toBeEnabled();
  await tabTo(page, add);
  await page.keyboard.press("Enter");
  await expect(panel.getByText("127.0.0.1", { exact: true })).toBeVisible();
  await expect(field).toHaveValue("");
  await tabTo(page, advanced);
  await page.keyboard.press("Enter");
}

/** Consent to the owner's explicitly named same-machine route using keys. */
export async function allowKeyboardMachine(page, tabTo) {
  const allow = page.getByRole("button", {
    name: "Allow the owner's addresses",
    exact: true,
  });
  await expect(allow).toBeVisible();
  await tabTo(page, allow);
  await page.keyboard.press("Enter");
}

/** Joining opens the person's own vault; return to shared items with keys. */
export async function reopenKeyboardSession(page, tabTo, focusIn) {
  await expect(inLiveSession(page)).toBeAttached({ timeout: 45_000 });
  await focusIn(page, ".vault", "after Connect opens the local vault");
  const open = page
    .getByRole("button", { name: "Open live session", exact: true })
    .filter({ visible: true });
  await tabTo(page, open);
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("img", { name: "Joined Team" })).toBeVisible({
    timeout: 45_000,
  });
  // The persistent shell key hands focus to the destination's joined status.
  await expect(page.locator("#live-status")).toBeFocused();
  await focusIn(page, "#live-status", "after opening shared items");
  const leave = page
    .locator(".live-join")
    .getByRole("button", { name: "Leave the session", exact: true });
  await expect(leave).toBeVisible();
  await tabTo(page, leave);
  await expect(leave).toBeFocused();
  await focusIn(page, ".live-join", "after tabbing into the shared session");
}

/** UI and real ICE state, without protocol message bodies or credentials. */
export async function showKeyboardPeers(owner, joiner) {
  for (const [who, page] of [
    ["owner", owner],
    ["joiner", joiner],
  ]) {
    const shown = await page
      .locator('[role="dialog"][aria-label="Share personal"], .live-join')
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => "(no live panel)");
    console.error(`${who} showed: ${shown.replace(/\s+/g, " ").slice(0, 400)}`);
    console.error(
      `${who} peer states: ${JSON.stringify(await peerStates(page))}`,
    );
  }
}

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
