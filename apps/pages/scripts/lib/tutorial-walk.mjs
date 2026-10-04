/**
 * Walking a tutorial the way a person does, in a real browser.
 *
 * The unit tests prove the runtime and the card; this proves the product: a
 * tutorial is started from the Support sheet's library, every step is read
 * off the page that is actually showing it, and the person gets through it
 * with nothing but Next. A step that points at a control is only a pass if
 * the control is lit, on screen, not covered by the card, and reachable
 * through the aperture. A step that cannot find its control is a failure
 * here, though it degrades to text for a person — a tutorial that points at
 * nothing is the bug this suite exists to catch.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PASSWORD } from "./pages-journey.mjs";
import { measureStep, stepChecks } from "./tutorial-measure.mjs";

export { stepChecks };

const MAX_STEPS = 40;

/** The Support mark, wherever this width draws it. */
export function supportKey(page) {
  return page.getByRole("button", { name: /^Support/ }).locator("visible=true");
}

export async function openSupport(page) {
  const sheet = page.getByRole("dialog", { name: "Support", exact: true });
  if (await sheet.isVisible().catch(() => false)) return sheet;
  await supportKey(page).first().click();
  await sheet.waitFor({ timeout: 15000 });
  return sheet;
}

export async function openLibrary(page) {
  const sheet = await openSupport(page);
  await sheet.getByRole("tab", { name: "Tutorials", exact: true }).click();
  await sheet.locator("[data-tutorial]").first().waitFor({ timeout: 10000 });
  return sheet;
}

/** Every tutorial the library offers from where the person is standing. */
export async function listTutorials(page) {
  const sheet = await openLibrary(page);
  const rows = await sheet.locator("[data-tutorial]").evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-tutorial"),
      title: node.querySelector(".support__tutorial-title")?.textContent ?? "",
      steps: Number.parseInt(
        node.querySelector(".support__tutorial-steps")?.textContent ?? "0",
        10,
      ),
    })),
  );
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  return rows;
}

export const tutorialDialog = (page) =>
  page.getByRole("dialog", { name: /^Tutorial:/ });

/** Starts one tutorial from the library and waits for its first card. */
export async function startTutorial(page, id) {
  const sheet = await openLibrary(page);
  await sheet.locator(`[data-tutorial="${id}"]`).click();
  const card = tutorialDialog(page);
  await card.waitFor({ timeout: 15000 });
  return card;
}

/**
 * The runtime gives a control TOUR_APPEAR_GRACE_MS to mount before it calls the
 * step degraded, and the card says "not on screen" from the first frame until
 * it does. "Not on screen" is therefore only an answer once it has outlasted
 * that grace; the walk reads the constant from the runtime so the two cannot
 * drift, and keeps a margin for a slow runner.
 */
const GRACE_MARGIN_MS = 2000;
export const APPEAR_GRACE_MS = (() => {
  try {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../packages/guide-runtime/src/tour.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const found = /TOUR_APPEAR_GRACE_MS\s*=\s*([\d_]+)/.exec(source);
    if (found) return Number(found[1].replaceAll("_", ""));
  } catch {
    // Not run from a checkout: the documented value stands.
  }
  return 2500;
})();

/** Waits for the card to be placed. A card that never is, is an error, not a pass. */
async function placed(page) {
  await page.waitForFunction(
    () =>
      !document.querySelector(".coach") ||
      Boolean(document.querySelector(".coach__card.is-placed")),
    undefined,
    { timeout: 10000 },
  );
}

/**
 * Waits for a step that points at a control to light it. Resolves when the
 * ring is drawn, or when the card has said "not on screen" continuously for
 * longer than the runtime's own grace — never on the first transient cue.
 */
async function lit(page) {
  await page.waitForFunction(
    ({ finalMs }) => {
      const root = document.querySelector(".coach");
      if (!root || !root.getAttribute("data-coach-target")) return true;
      const key = `${root.getAttribute("data-coach-step")}:${root.getAttribute("data-coach-kind")}`;
      if (root.getAttribute("data-coach-degraded") !== "true") {
        window.__walkMissing = null;
        return Boolean(root.querySelector(".coach__ring"));
      }
      if (window.__walkMissing?.key !== key)
        window.__walkMissing = { key, since: performance.now() };
      return performance.now() - window.__walkMissing.since >= finalMs;
    },
    { finalMs: APPEAR_GRACE_MS + GRACE_MARGIN_MS },
    { timeout: APPEAR_GRACE_MS + GRACE_MARGIN_MS + 20000, polling: "raf" },
  );
}

/**
 * Waits for the aperture and the card to stop moving: no glide in flight and
 * the same boxes for several frames running. Replaces a fixed sleep with the
 * condition the sleep stood for.
 */
async function settled(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".coach");
      if (!root) return true;
      const card = root.querySelector(".coach__card");
      if (!card?.classList.contains("is-placed")) return false;
      if (root.querySelector(".is-gliding")) return false;
      const ring = root.querySelector(".coach__ring");
      const sig = [
        root.getAttribute("data-coach-step"),
        root.getAttribute("data-coach-kind"),
        JSON.stringify(card.getBoundingClientRect()),
        ring ? JSON.stringify(ring.getBoundingClientRect()) : "-",
      ].join("|");
      const held = window.__walkSettled;
      if (held?.sig === sig) held.frames += 1;
      else window.__walkSettled = { sig, frames: 0 };
      return window.__walkSettled.frames >= 4;
    },
    undefined,
    { timeout: 10000, polling: "raf" },
  );
}

/** Whether the card on screen differs from `before` (a step number and kind). */
export async function advancedFrom(page, before, timeout = 6000) {
  try {
    await page.waitForFunction(
      (held) => {
        const root = document.querySelector(".coach");
        if (!root) return true;
        return (
          root.getAttribute("data-coach-step") !== String(held.step) ||
          root.getAttribute("data-coach-kind") !== held.kind
        );
      },
      { step: before.step, kind: before.kind },
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

/** Waits for the card to show a given step number. */
export async function reachedStep(page, step, timeout = 6000) {
  try {
    await page.waitForFunction(
      (want) =>
        document.querySelector(".coach")?.getAttribute("data-coach-step") ===
        String(want),
      step,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything one step shows, measured in the page once the step is placed, its
 * control lit (or given up on past the runtime's grace) and everything still.
 */
export async function readStep(page) {
  await placed(page);
  await lit(page);
  await settled(page);
  return page.evaluate(measureStep);
}

/** Re-enters the first screen of the shell without reloading (which locks). */
export async function resetToVault(page, base) {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}vault`);
  await page.waitForFunction(
    (path) => location.pathname === path && !document.querySelector(".coach"),
    `${base}vault`,
    { timeout: 10000 },
  );
}

/**
 * Unlocks if the page is on the unlock screen. A load locks the vault, and the
 * screen paints a moment after the document does, so this waits for whichever
 * of the two states arrives before deciding which one it is in.
 */
export async function unlockIfLocked(page) {
  const field = page.getByLabel("Password", { exact: true });
  const open = page
    .getByRole("button", { name: "Lock vault" })
    .locator("visible=true")
    .first();
  await Promise.race([
    field.waitFor({ state: "visible", timeout: 10000 }),
    open.waitFor({ state: "visible", timeout: 10000 }),
  ]).catch(() => {});
  if (!(await field.isVisible().catch(() => false))) return false;
  await field.fill(PASSWORD);
  await field.press("Enter");
  await open.waitFor({ timeout: 20000 });
  return true;
}

/** Presses Next by mouse or by keyboard, whichever this step is owed. */
async function pressNext(page, { info, byKeyboard, check, label }) {
  const next = page.locator(".coach__btn--go");
  if (!byKeyboard) {
    await next.click();
    return;
  }
  check(
    info.focusInCard,
    `${label}: focus is on the card, so Enter reaches Next`,
  );
  if (!info.focusInCard) await next.focus();
  await page.keyboard.press("Enter");
}

/**
 * Press Next through a whole tutorial, checking every step. Returns the
 * ordered list of steps seen. `press` alternates mouse and keyboard so both
 * roads are walked on every tutorial. Steps are numbered 1..N with none
 * skipped, and N is what the tutorial declared (`total`, when known).
 */
export async function walkSteps(
  page,
  { id, check, phone, total = null, snap = null, press = "alternate" },
) {
  const seen = [];
  let expected = 1;
  for (let guard = 0; guard < MAX_STEPS; guard += 1) {
    const info = await readStep(page);
    if (!info) {
      check(false, `${id}: the tutorial ended without a closing card`);
      return seen;
    }
    const label = `${id} · ${info.kind} ${info.counter || ""}`.trim();
    for (const [ok, what] of stepChecks(info, { phone }))
      check(ok, `${label}: ${what}`);
    if (info.kind === "close") {
      const shown = seen.length;
      if (total !== null && Number.isFinite(total)) {
        check(
          shown === total,
          `${id}: ${shown} steps were shown before the close, the tutorial declared ${total}`,
        );
      }
      seen.push(info);
      if (snap) await snap(info, guard);
      return seen;
    }
    check(
      info.step === expected,
      `${label}: the walk is at step ${expected}, never a skip (the card shows ${info.step})`,
    );
    expected = info.step + 1;
    seen.push(info);
    if (snap) await snap(info, guard);

    const byKeyboard =
      press === "keyboard" || (press === "alternate" && guard % 2 === 1);
    await pressNext(page, { info, byKeyboard, check, label });
    if (!(await advancedFrom(page, info))) {
      check(false, `${label}: Next did not move the tutorial on`);
      return seen;
    }
  }
  check(
    false,
    `${id}: the tutorial never reached its closing card in ${MAX_STEPS} steps`,
  );
  return seen;
}
