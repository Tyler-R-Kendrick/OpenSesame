// A live session walked with the keyboard alone (ADR 0150 + the keyboard
// contract in AGENTS.md §5): the owner starts and ends one from Settings ›
// Live sessions, a second device asks, is let in, connects over real WebRTC
// and is turned away — and after every swap the keyboard is somewhere a
// person can see and use, never <body>.
//
// Every step is a real key press. Nothing is clicked, focused or dispatched;
// the only `evaluate` calls read the page (where focus is, what the clipboard
// holds after the Copy key was pressed), which is how a person would read it.
//
// Not covered here: the front door's Join road and its consent (walked by
// FrontDoor tests and verify:static) — the joiner opens the link, the way
// "a shared link opens join by itself" — and the carriers, which need their
// servers (verify:live-join).

import { chromium, expect } from "@playwright/test";
import { approveByKeyboard } from "./capability-keyboard-contract.mjs";

/** Where the keyboard is, in words a failure can quote. */
function whereFocus(selector) {
  const el = document.activeElement;
  if (!el || el === document.body) return "on <body>";
  const name = el.getAttribute("aria-label") || el.id || el.tagName;
  if (!el.closest(selector)) return `outside ${selector}: ${name}`;
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  if (box.width === 0 || box.height === 0 || style.visibility === "hidden")
    return `hidden: ${name}`;
  if (!el.matches(":focus-visible")) return `no focus ring: ${name}`;
  return "ok";
}

/**
 * Ringed is not seen: the focused control must sit inside the viewport and be
 * what a finger or a pointer hits at its centre, not the sticky strip or bar
 * that scrolled over it (AGENTS.md §5, "visible, useful focus").
 */
function whereSeen() {
  const el = document.activeElement;
  const box = el.getBoundingClientRect();
  const name = el.getAttribute("aria-label") || el.id || el.tagName;
  const where = `${Math.round(box.width)}x${Math.round(box.height)} at (${Math.round(box.left)},${Math.round(box.top)})`;
  const inside =
    box.top >= 0 &&
    box.left >= 0 &&
    box.bottom <= window.innerHeight &&
    box.right <= window.innerWidth;
  if (!inside) return `outside the viewport: ${name}, ${where}`;
  const x = box.left + box.width / 2;
  const hit = document.elementFromPoint(x, box.top + box.height / 2);
  if (hit && (el === hit || el.contains(hit) || hit.contains(el))) return "ok";
  return `covered by ${hit?.className || hit?.tagName}: ${name}, ${where}`;
}

/**
 * The keyboard is inside `selector`, on something drawn, ringed, inside the
 * viewport and not covered by other chrome — not <body>.
 */
export async function focusIn(page, selector, what) {
  const read = async () => {
    const found = await page.evaluate(whereFocus, selector);
    return found === "ok" ? page.evaluate(whereSeen) : found;
  };
  await expect
    .poll(read, { message: `${what}: focus`, timeout: 10_000 })
    .toBe("ok");
}

/** Print where the focused control sits and what is at its centre (evidence). */
async function measure(page, what) {
  const found = await page.evaluate(() => {
    const el = document.activeElement;
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const hit = document.elementFromPoint(x, b.top + b.height / 2);
    const at = `(${Math.round(b.left)},${Math.round(b.top)})`;
    return `${el.getAttribute("aria-label")}: ${Math.round(b.width)}x${Math.round(b.height)} at ${at}; at its centre: ${hit?.className || hit?.tagName}`;
  });
  const { width, height } = page.viewportSize();
  console.log(`MEASURE ${what} (${width}x${height}): ${found}`);
}

/** The name of the focused control: its label, else its text. */
const focusedName = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el?.getAttribute("aria-label") || el?.id || el?.tagName || "";
  });

async function copied(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** A guest device with one login in it, and Live sessions chosen. */
async function ownerEnters(page, { origin, base, tabTo, width }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("button", { name: "Set up your own" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Skip sign-in and continue as guest" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const create = page.getByRole("link", { name: "New item", exact: true });
  // A phone opens the vault on its section tree; Enter on it opens the list.
  if (width !== 1280) {
    await expect(page.locator(".railtree")).toBeFocused();
    await page.keyboard.press("Enter");
  }
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByLabel("Name", { exact: true }));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("GitHub");
  await tabTo(
    page,
    page.getByRole("button", { name: "Save item", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(page.locator("form.editor")).toHaveCount(0);
  await approveByKeyboard(page, tabTo, ["Live sessions"]);
}

/** Settings › Live sessions, by keyboard, with the session panel showing. */
async function openLive(page, tabTo) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/settings(?:[/?].*)?$/, { timeout: 10_000 });
  const tab = page.getByRole("link", { name: "Live sessions", exact: true });
  await tabTo(page, tab.first());
  await page.keyboard.press("Enter");
  await expect(page.locator("#live-session")).toBeVisible({ timeout: 20_000 });
}

/** The owner names a session and starts it; the keyboard lands in the live view. */
async function ownerStarts(page, tabTo) {
  const panel = page.locator("#live-session");
  await tabTo(page, panel.getByLabel("Session name"));
  await page.keyboard.insertText("Team");
  await tabTo(page, panel.getByRole("checkbox", { name: "GitHub" }));
  await page.keyboard.press("Space");
  const start = panel.getByRole("button", { name: "Start the live session" });
  await expect(start).toBeEnabled();
  await tabTo(page, start);
  await page.keyboard.press("Enter");
  const copyLink = panel.getByRole("button", { name: "Copy the link" });
  await expect(copyLink, "Start lands on the Copy link key").toBeFocused();
  if (process.env.LIVE_MEASURE) await measure(page, "after Start");
  await focusIn(page, "#live-session", "after Start");
  await page.keyboard.press("Enter");
  const link = await copied(page);
  const code = (await panel.locator(".live-code").innerText()).trim();
  return { link, code };
}

/** The joiner opens the link, fills the form and asks; the request code. */
async function joinerAsks(page, { link, code, tabTo }) {
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
  await tabTo(page, page.getByLabel("Code", { exact: true }));
  await page.keyboard.insertText(code.toLowerCase());
  await tabTo(page, page.getByLabel("Your name"));
  await page.keyboard.insertText("Ada Lovelace");
  await page.keyboard.press("Enter");
  const copy = page.getByRole("button", { name: "Copy your request code" });
  // A request code waits on this browser's ICE gathering.
  await expect(copy, "asking lands on the request code").toBeFocused({
    timeout: 20_000,
  });
  await focusIn(page, ".live-join", "after asking");
  await page.keyboard.press("Enter");
  return copied(page);
}

/** The owner pastes the request, lets the joiner in, and copies the reply. */
async function ownerAdmits(page, { request, tabTo }) {
  const panel = page.locator("#live-session");
  const field = panel.getByLabel("A request code", { exact: true });
  await tabTo(page, field);
  await page.keyboard.insertText(request);
  await page.keyboard.press("Enter");
  const letIn = panel.getByRole("button", { name: "Let Ada Lovelace in" });
  await expect(letIn).toBeVisible();
  await expect(field, "a paste returns to its field").toBeFocused();
  await focusIn(page, "#live-session", "after a paste");
  await tabTo(page, letIn);
  await page.keyboard.press("Enter");
  const reply = panel.getByRole("button", {
    name: "Copy the reply code for Ada Lovelace",
  });
  await expect(reply, "Let in lands on the reply code").toBeFocused();
  await focusIn(page, "#live-session", "after Let in");
  await page.keyboard.press("Enter");
  return copied(page);
}

/** A wrong reply keeps the field; the right one joins, and focus follows. */
async function joinerConnects(page, { reply, tabTo }) {
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

/** The owner removes the guest, the joiner starts over and closes; the owner ends. */
async function endings(owner, joiner, { tabTo }) {
  const panel = owner.locator("#live-session");
  const remove = panel.getByRole("button", { name: "Remove Ada Lovelace" });
  await tabTo(owner, remove);
  await owner.keyboard.press("Enter");
  await expect(
    panel.getByRole("img", { name: "Left" }).or(panel.getByText("Left")),
  ).toBeVisible();
  await expect(
    panel.getByLabel("A request code", { exact: true }),
    "Remove lands on the request field",
  ).toBeFocused();
  await focusIn(owner, "#live-session", "after Remove");

  await expect(
    joiner.getByRole("img", { name: "The session ended" }),
  ).toBeVisible({ timeout: 15_000 });
  await focusIn(joiner, ".live-join", "after the session ended");
  const startOver = joiner.getByRole("button", { name: "Start over" });
  await tabTo(joiner, startOver, "Shift+Tab");
  await joiner.keyboard.press("Enter");
  await expect(joiner.getByLabel("Your name")).toBeVisible();
  await focusIn(joiner, ".live-join form", "after Start over");
  const close = joiner.getByRole("button", { name: "Close", exact: true });
  await tabTo(joiner, close, "Shift+Tab");
  await joiner.keyboard.press("Enter");
  await expect(joiner).not.toHaveURL(/\/live/);
  await expect
    .poll(async () => (await focusedName(joiner)) !== "BODY", {
      message: "closing the screen lands on a control",
    })
    .toBe(true);

  const end = panel.getByRole("button", {
    name: "End the session for everyone",
  });
  await tabTo(owner, end);
  await owner.keyboard.press("Enter");
  const confirmEnd = panel.getByRole("button", { name: "End for everyone" });
  await tabTo(owner, confirmEnd);
  await owner.keyboard.press("Enter");
  await expect(
    panel.getByLabel("Session name"),
    "End lands on the form",
  ).toBeFocused();
  await focusIn(owner, "#live-session", "after End");
}

/**
 * One owner and one joiner, at `width`: Start, ask, Let in, Connect, Remove,
 * Start over, Close and End, each with the keyboard landing somewhere.
 */
export async function liveKeyboardContract({
  harness,
  origin,
  base,
  width,
  tabTo,
}) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    headless: true,
    args: [
      "--allow-loopback-in-peer-connection",
      // Host candidates as plain addresses, not `<uuid>.local` names: two
      // browsers on one runner would resolve those names over multicast DNS,
      // which a hosted runner does not reliably carry. IPv6 host candidates
      // on that runner often never leave "checking", so the joiner sits on
      // "Connecting" until the wait expires. The keyboard contract is about
      // where focus goes (verify:live-join walks the real network paths).
      "--disable-ipv6",
      "--disable-features=LocalNetworkAccessChecks,WebRtcHideLocalIpsWithMdns",
    ],
  });
  try {
    const device = async () => {
      const made = await harness.newPage(browser);
      await made.context.grantPermissions(
        ["clipboard-read", "clipboard-write"],
        {
          origin,
        },
      );
      // A public origin pairing over loopback is a local-network access.
      // Headless has no prompt to allow it, and a pending check stays on
      // "Connecting" instead of failing. Same grant as verify:live-join.
      const cdp = await made.context.newCDPSession(made.page);
      await cdp.send("Browser.setPermission", {
        permission: { name: "local-network-access" },
        setting: "granted",
        origin,
      });
      await made.page.setViewportSize({
        width,
        height: width < 600 ? 640 : 900,
      });
      return made;
    };
    const showed = async (owner, joiner) => {
      // Say what each side showed, so a connection that never forms reads as
      // one, not as a bare "element(s) not found".
      for (const [who, page] of [
        ["owner", owner],
        ["joiner", joiner],
      ]) {
        const shown = await page
          .locator("#live-session, .live-join")
          .first()
          .innerText({ timeout: 2000 })
          .catch(() => "(no live panel)");
        console.error(
          `${who} showed: ${shown.replace(/\s+/g, " ").slice(0, 400)}`,
        );
      }
    };
    const walk = async () => {
      const owner = await device();
      let joiner = null;
      try {
        await ownerEnters(owner.page, { origin, base, tabTo, width });
        await openLive(owner.page, tabTo);
        const { link, code } = await ownerStarts(owner.page, tabTo);
        joiner = await device();
        const request = await joinerAsks(joiner.page, { link, code, tabTo });
        const reply = await ownerAdmits(owner.page, { request, tabTo });
        await joinerConnects(joiner.page, { reply, tabTo }).catch(
          async (error) => {
            await showed(owner.page, joiner.page);
            throw error;
          },
        );
        await endings(owner.page, joiner.page, { tabTo });
      } finally {
        await owner.context.close().catch(() => undefined);
        await joiner?.context.close().catch(() => undefined);
      }
    };
    try {
      await walk();
    } catch {
      // One more walk. A loopback check that never completes is the flake
      // this shard hits; a second pair of browsers gets a new socket.
      console.error("live keyboard: connection did not form; trying once more");
      await walk();
    }
  } finally {
    await browser.close();
  }
  console.log(
    `PASS live sessions (${width}px): Start, ask, Let in, Connect, Remove, Start over, Close and End each leave the keyboard on a visible control`,
  );
}
