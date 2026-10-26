/** The current owner seal and joiner-local-vault ceremonies, using only keys. */
import { expect } from "@playwright/test";
import { joinedSession } from "./live-joined.mjs";

const PIN = "48291037";

/** Focus metadata only: no field values, notice text, or clipboard material. */
export async function logLiveFocus(page, who) {
  const focus = await page.evaluate(() => {
    const held = document.activeElement;
    return {
      tag: held?.tagName,
      id: held?.id,
      role: held?.getAttribute("role"),
      controls: held?.getAttribute("aria-controls"),
    };
  });
  console.error(`${who} focus: ${JSON.stringify(focus)}`);
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
  // Applying the plan loads the live form asynchronously. Wait for that
  // form before deciding whether its required out-of-band code is present.
  await expect(page.getByLabel("Your name")).toBeVisible();
  if (code) {
    const codeField = page.getByLabel("Code", { exact: true });
    await expect(codeField).toBeVisible();
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

/** A wrong reply keeps the field; the right one joins, and focus follows. */
export async function joinerConnects(page, { reply, tabTo, focusIn }) {
  const field = page.getByLabel("The owner's reply code", { exact: true });
  await tabTo(page, field);
  await page.keyboard.insertText("osl-reply.nope.nope");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("img", { name: "That reply is not for this request" }),
  ).toBeVisible();
  await expect(field, "a wrong reply returns to its field").toBeFocused();
  await focusIn(page, ".live-join", "after a wrong reply");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(reply);
  await page.keyboard.press("Enter");
  const allow = page.getByRole("button", {
    name: "Allow the owner's addresses",
    exact: true,
  });
  await expect(allow).toBeVisible();
  await tabTo(page, allow);
  await page.keyboard.press("Enter");
  await joinedSession(page);
  await expect(page.locator(".vault")).toBeVisible();
  await focusIn(page, ".app", "after joining the local vault");
  const shared = page
    .getByRole("button", {
      name: "Open live session",
      exact: true,
    })
    .filter({ visible: true });
  await tabTo(page, shared);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("img", { name: "Joined Team" }),
    "the two browsers connected",
  ).toBeVisible({ timeout: 45_000 });
  await expect(
    page.locator("#live-status"),
    "Connect lands on the session's status",
  ).toBeFocused();
  await focusIn(page, ".live-join", "after Connect");
}

/** Two browsers on this machine explicitly name loopback, using only keys. */
export async function nameKeyboardLoopback(page, panel, tabTo) {
  const advanced = panel.locator("details.live-advanced");
  const summary = advanced.locator("summary");
  await tabTo(page, summary);
  await page.keyboard.press("Enter");
  const routes = panel.locator("#live-routes");
  const address = routes.getByLabel("Tailnet, VPN or LAN address");
  await tabTo(page, address);
  await page.keyboard.insertText("127.0.0.1");
  await tabTo(
    page,
    routes.getByRole("button", { name: "Add the address", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(routes.getByText("127.0.0.1", { exact: true })).toBeVisible();
  await expect(address).toHaveValue("");
  await tabTo(page, summary);
  await page.keyboard.press("Enter");
}
