/**
 * The gate pass of `verify-tutorials.mjs` (ADR 0166): every screen in front of
 * the shell draws one help key, and every tutorial a gate offers is started
 * from that key, on the real screen, and walked like any other.
 *
 * Besides the walk, each gate is held to what the ADR says about the key
 * itself: one key and no more, a plain icon key with its label and title, the
 * 44px floor on a phone, in the screen's own chrome and never on top of a
 * control, reachable by Tab, and never given the focus on arrival (the screen
 * lands its own). The library a gate offers is exactly the tutorials written
 * for it — never one of the shell's.
 *
 * The gates are reached the way a person reaches them: the door on a device
 * with nothing on it; setup from the door; sign-in and the seal after setup is
 * skipped; unlock after the vault is sealed and the page reloaded; and the
 * broker and federation screens by the addresses a site and a provider send
 * people to.
 */

import { PASSWORD } from "./pages-journey.mjs";
import { listTutorials, readStep, startTutorial } from "./tutorial-walk.mjs";

/** What the key is measured by, read in the page: its box, its name, and what it touches. */
function measureKey() {
  const keys = [...document.querySelectorAll("button")].filter(
    (button) =>
      /^Support/.test(button.getAttribute("aria-label") ?? "") &&
      button.getClientRects().length > 0,
  );
  const key = keys[0];
  if (!key) return { count: 0 };
  const box = key.getBoundingClientRect();
  const touching = [
    ...document.querySelectorAll(
      'a[href], button, input, select, textarea, summary, [role="tab"], [tabindex]',
    ),
  ]
    .filter((node) => node !== key && !key.contains(node))
    .filter((node) => node.getClientRects().length > 0)
    .filter((node) => getComputedStyle(node).visibility !== "hidden")
    .filter((node) => {
      const other = node.getBoundingClientRect();
      return (
        other.width > 1 &&
        other.height > 1 &&
        other.left < box.right &&
        other.right > box.left &&
        other.top < box.bottom &&
        other.bottom > box.top
      );
    })
    .map(
      (node) =>
        node.getAttribute("aria-label") ||
        node.textContent?.trim().slice(0, 30) ||
        node.tagName,
    );
  return {
    count: keys.length,
    // Layout size, not the painted box: a screen that eases in is a pixel
    // short of its size for a moment, and the floor is about the key.
    width: key.offsetWidth,
    height: key.offsetHeight,
    label: key.getAttribute("aria-label"),
    title: key.getAttribute("title"),
    inViewport:
      box.left >= 0 &&
      box.top >= 0 &&
      box.right <= innerWidth &&
      box.bottom <= innerHeight,
    floating: getComputedStyle(key).position === "fixed",
    touching,
  };
}

/** Whether Tab, pressed from the start of the page, reaches the key. */
async function tabReaches(page) {
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  for (let presses = 0; presses < 30; presses += 1) {
    await page.keyboard.press("Tab");
    const there = await page.evaluate(() =>
      /^Support/.test(document.activeElement?.getAttribute("aria-label") ?? ""),
    );
    if (there) return presses + 1;
  }
  return 0;
}

/** The key as a person finds it on this screen. */
async function keyChecks({ check, phone, say }, page, label) {
  // The capability that draws the key activates after the screen it sits on
  // (a popup's route can register first), so give it the time a person's
  // first look would, and fail only when it never comes.
  await page
    .getByRole("button", { name: /^Support/ })
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  const m = await page.evaluate(measureKey);
  check(m.count === 1, `${label}: exactly one help key is drawn (${m.count})`);
  if (m.count !== 1) return;
  check(m.label === "Support", `${label}: the key is named (${m.label})`);
  check(m.title === m.label, `${label}: the key has a title`);
  const floor = phone ? 44 : 32;
  check(
    m.width >= floor && m.height >= floor,
    `${label}: the key is at least ${floor}px (${m.width}x${m.height})`,
  );
  check(m.inViewport, `${label}: the key is inside the screen`);
  check(
    !m.floating,
    `${label}: the key sits in the screen's own chrome, not floating over it`,
  );
  check(
    m.touching.length === 0,
    `${label}: the key rests on no control (${m.touching.join(", ")})`,
  );
  const presses = await tabReaches(page);
  check(presses > 0, `${label}: Tab reaches the key (${presses} presses)`);
  say(`  ${label}: key ${m.width}x${m.height}, Tab ${presses}`);
}

/** The tutorials this screen's key lists, and nothing but gate tutorials. */
async function offered(page, check, label, wanted) {
  const rows = await listTutorials(page);
  const ids = rows.map((row) => row.id);
  check(
    wanted.every((id) => ids.includes(id)),
    `${label}: the key offers ${wanted.join(", ")} (it offers ${ids.join(", ") || "nothing"})`,
  );
  check(
    ids.every((id) => id.startsWith("gate.")),
    `${label}: the key offers none of the shell's tutorials (${ids.join(", ")})`,
  );
  return rows;
}

/** On this gate: the key, what it offers, and every tutorial it offers, walked. */
function walkerFor(env, page) {
  const { width, phone, check, setWhere } = env;
  const { wants, walkGate } = env.helpers;
  return async function walkHere(label, wanted) {
    setWhere(`${width}px ${label}`);
    await keyChecks(
      { check, phone, say: env.helpers.say },
      page,
      `${width}px ${label}`,
    );
    const rows = await offered(page, check, `${width}px ${label}`, wanted);
    for (const row of rows) {
      if (wants(row.id)) await walkGate(page, row, { phone, width });
    }
  };
}

/** Escape leaves a tour on a gate as it does in the shell, and hands focus back. */
async function escapeOnTheDoor(check, page) {
  await startTutorial(page, "gate.front-door");
  await readStep(page);
  await page.keyboard.press("Escape");
  const gone = await page
    .waitForFunction(() => !document.querySelector(".coach"), undefined, {
      timeout: 4000,
    })
    .then(
      () => true,
      () => false,
    );
  check(gone, "door: Escape on the card ends the tutorial");
  const held = await page.evaluate(
    () => document.activeElement?.tagName ?? "none",
  );
  check(held !== "BODY", `door: focus is handed back after Escape (${held})`);
}

/** The door of a device with nothing on it, and its one help key. */
async function doorGate(env, page, walkHere) {
  const { origin, base, check, setWhere, width } = env;
  setWhere(`${width}px door`);
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Set up your own" })
    .waitFor({ timeout: 30000 });
  const landed = await page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? "",
  );
  check(
    landed === "Set up your own",
    `door: the screen lands its own focus, never the help key (${landed})`,
  );
  const skips = await page
    .getByRole("button", { name: "Skip sign-in and continue as guest" })
    .count();
  check(skips === 1, "door: the guest Skip is still one press away");
  await walkHere("door", ["gate.front-door", "gate.join"]);
  await env.helpers.guarded(page, "door escape", () =>
    escapeOnTheDoor(check, page),
  );
}

/** Setup from the door: the choice, then each tab of the ceremony that has a tour. */
async function setupGate(env, page, walkHere) {
  const { say } = env.helpers;
  await page.getByRole("button", { name: "Set up your own" }).click();
  await page.getByRole("button", { name: "Custom" }).waitFor();
  await walkHere("setup choice", ["gate.setup.choose"]);
  await page.getByRole("button", { name: "Custom" }).click();
  await page.getByRole("tablist", { name: "Setup step" }).waitFor();
  await walkHere("setup capabilities", ["gate.setup"]);
  for (const [tab, goal] of [
    ["identity", "gate.setup.ways"],
    ["connectors", "gate.setup.connectors"],
  ]) {
    // Both tabs belong to optional capabilities, so a default installation
    // draws neither: say so rather than walk a screen that is not there.
    const handle = page.getByRole("tab", { name: tab, exact: true });
    if ((await handle.count()) === 0) {
      say(`  setup: no ${tab} tab on this installation`);
      continue;
    }
    await handle.click();
    await walkHere(`setup ${tab}`, [goal]);
  }
  await page.getByRole("button", { name: "Skip all" }).first().click();
}

/** Sign-in, then the seal without an account: each method, then a vault made. */
async function sealGate(page, walkHere) {
  await page
    .getByRole("heading", { level: 1, name: "Sign in" })
    .waitFor({ timeout: 15000 });
  await walkHere("sign-in", ["gate.sign-in"]);
  await page.getByRole("button", { name: "Use without an account" }).click();
  const passkey = page.getByRole("tab", { name: "Passkey", exact: true });
  if ((await passkey.count()) > 0) {
    await passkey.click();
    await walkHere("seal passkey", ["gate.unlock.passkey"]);
  }
  await page.getByRole("tab", { name: "Password", exact: true }).click();
  await walkHere("seal password", ["gate.unlock"]);
  await page.getByLabel("Master password", { exact: true }).fill(PASSWORD);
  await page
    .getByLabel("Confirm master password", { exact: true })
    .fill(PASSWORD);
  await page
    .getByLabel("I understand this vault cannot be recovered.", { exact: true })
    .check();
  await page.getByRole("button", { name: "Seal this device" }).click();
  await page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 20000 });
}

export async function gatePass(env) {
  const { width, newPage, origin, base } = env;
  const { page, context } = await newPage(width);
  const walkHere = walkerFor(env, page);
  await doorGate(env, page, walkHere);
  await setupGate(env, page, walkHere);
  await sealGate(page, walkHere);
  // Unlock: the vault just sealed, on a fresh load, which locks it.
  await page.goto(`${origin}${base}vault`, { waitUntil: "domcontentloaded" });
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 20000 });
  await walkHere("unlock", ["gate.unlock", "gate.unlock.account"]);
  await context.close();
}

/**
 * The broker popup and the federation return, in a context that has switched
 * every capability on (the broker is an optional section; the return is core).
 * Each is a page of its own, reached by the address that sends people there.
 */
export async function popupPass(env) {
  const { context, origin, base } = env;
  const page = await context.newPage();
  const walkHere = walkerFor(env, page);
  await page.goto(`${origin}${base}broker/authorize`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("heading", { name: "Sign in for a static site" })
    .waitFor({ timeout: 20000 });
  await walkHere("broker popup", ["gate.broker.consent"]);
  await page.goto(`${origin}${base}?error=access_denied`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .getByRole("button", { name: "Back to sign-in" })
    .waitFor({ timeout: 20000 });
  await walkHere("federation return", ["gate.federation.return"]);
  await page.close();
}
