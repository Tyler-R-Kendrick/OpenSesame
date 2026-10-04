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

import { PASSWORD } from "./pages-journey.mjs";

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
 * Everything one step shows, measured in the page. Waits for the step to be
 * placed, and — for a step that points at a control — for the control to be
 * lit or for the card to say it is not on screen, whichever the product does.
 */
export async function readStep(page) {
  await page
    .locator(".coach__card.is-placed")
    .waitFor({ timeout: 8000 })
    .catch(() => {});
  await page
    .waitForFunction(
      () => {
        const root = document.querySelector(".coach");
        if (!root) return true;
        if (root.getAttribute("data-coach-kind") !== "point") return true;
        const degraded = root.textContent?.includes("not on screen");
        return Boolean(root.querySelector(".coach__ring")) || degraded;
      },
      undefined,
      { timeout: 6000 },
    )
    .catch(() => {});
  // The aperture glides for 300ms between steps; measure after it lands.
  await page.waitForTimeout(340);
  return page.evaluate(measureStep);
}

/**
 * Runs in the page: everything one step shows. Small helpers, so the
 * measurement stays readable and each one is simple to trust.
 */
function measureStep() {
  const root = document.querySelector(".coach");
  if (!root) return null;
  const text = (selector) => root.querySelector(selector)?.textContent ?? "";
  const box = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const { left, top, right, bottom, width, height } = r;
    return { left, top, right, bottom, width, height };
  };
  const clamp = (value, max) => Math.min(Math.max(value, 0), max);
  const whatIsAt = (ringBox) => {
    if (!ringBox) return null;
    const x = clamp(ringBox.left + ringBox.width / 2, innerWidth - 1);
    const y = clamp(ringBox.top + ringBox.height / 2, innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    return {
      dim: hit.classList.contains("coach__dim"),
      card: Boolean(hit.closest(".coach__card")),
    };
  };
  const card = root.querySelector(".coach__card");
  const ring = root.querySelector(".coach__ring");
  const go = root.querySelector(".coach__btn--go");
  const back = [...root.querySelectorAll(".coach__btn")].find((b) =>
    /Back|Replay/.test(b.textContent ?? ""),
  );
  const ringBox = box(ring);
  return {
    kind: root.getAttribute("data-coach-kind"),
    step: Number(root.getAttribute("data-coach-step")),
    counter: text(".coach__count"),
    title: text(".coach__title"),
    text: text(".coach__text"),
    cue: text(".coach__cue"),
    notOnScreen: text(".coach__cue").includes("not on screen"),
    action: Boolean(ring?.classList.contains("is-action")),
    card: box(card),
    ring: ringBox,
    underAperture: whatIsAt(ringBox),
    go: box(go),
    goDisabled: go ? go.disabled : null,
    backDisabled: back ? back.disabled : null,
    focusInCard: Boolean(card?.contains(document.activeElement)),
    viewport: {
      width: document.documentElement.clientWidth,
      height: innerHeight,
    },
  };
}

function intersects(a, b) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

const inside = (box, viewport) =>
  box.left >= -0.5 &&
  box.top >= -0.5 &&
  box.right <= viewport.width + 0.5 &&
  box.bottom <= viewport.height + 0.5;

const touches = (box, viewport) =>
  box.width > 0 &&
  box.height > 0 &&
  box.right > 0 &&
  box.bottom > 0 &&
  box.left < viewport.width &&
  box.top < viewport.height;

const describe = (box) =>
  `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`;

/** The card, and Next on it. */
function cardChecks(info, phone) {
  const { card, go, viewport } = info;
  const out = [
    [
      inside(card, viewport),
      `the card sits inside the viewport (${describe(card)} in ${viewport.width}x${viewport.height})`,
    ],
    [
      Boolean(go) && go.width > 0 && !info.goDisabled,
      "Next is present and enabled",
    ],
    [info.text.trim().length > 0, "the step says something"],
  ];
  if (!go) return out;
  out.push([inside(go, viewport), "Next is inside the viewport"]);
  if (phone) {
    out.push([
      go.height >= 43.5,
      `Next is a 44px key on a phone (${Math.round(go.height)}px)`,
    ]);
  }
  return out;
}

/** The lit control: there, visible, uncovered by the card, reachable. */
function litChecks(info) {
  const { card, ring, viewport, underAperture } = info;
  const out = [
    [!info.notOnScreen, "the control the step points at is on screen"],
  ];
  if (!ring) return out;
  out.push(
    [touches(ring, viewport), "the lit control is inside the viewport"],
    [!intersects(card, ring), "the card does not cover the lit control"],
    [
      underAperture === null || !underAperture.dim,
      "the lit control is reachable through the aperture",
    ],
  );
  return out;
}

/** The checks every step owes, as [ok, what] pairs. */
export function stepChecks(info, { phone }) {
  if (!info.card) return [[false, "the card is on screen"]];
  const out = [[true, "the card is on screen"], ...cardChecks(info, phone)];
  if (info.kind === "point") out.push(...litChecks(info));
  return out;
}

/** Re-enters the first screen of the shell without reloading (which locks). */
export async function resetToVault(page, base) {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}vault`);
  await page.waitForTimeout(250);
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

/**
 * Press Next through a whole tutorial, checking every step. Returns the
 * ordered list of steps seen. `pointer` alternates mouse and keyboard so both
 * roads are walked on every tutorial.
 */
export async function walkSteps(
  page,
  { id, check, phone, snap = null, press = "alternate" },
) {
  const seen = [];
  for (let guard = 0; guard < MAX_STEPS; guard += 1) {
    const info = await readStep(page);
    if (!info) {
      check(false, `${id}: the tutorial ended without a closing card`);
      return seen;
    }
    const label = `${id} · ${info.kind} ${info.counter || ""}`.trim();
    for (const [ok, what] of stepChecks(info, { phone }))
      check(ok, `${label}: ${what}`);
    seen.push(info);
    if (snap) await snap(info, guard);
    if (info.kind === "close") return seen;

    const next = page.locator(".coach__btn--go");
    const byKeyboard =
      press === "keyboard" || (press === "alternate" && guard % 2 === 1);
    if (byKeyboard) {
      check(
        info.focusInCard,
        `${label}: focus is on the card, so Enter reaches Next`,
      );
      if (!info.focusInCard) await next.focus();
      await page.keyboard.press("Enter");
    } else {
      await next.click();
    }
    // The next card is the next step, never a skip.
    await page
      .waitForFunction(
        (before) => {
          const root = document.querySelector(".coach");
          if (!root) return true;
          return (
            root.getAttribute("data-coach-step") !== String(before.step) ||
            root.getAttribute("data-coach-kind") !== before.kind
          );
        },
        { step: info.step, kind: info.kind },
        { timeout: 6000 },
      )
      .catch(() => {});
  }
  check(
    false,
    `${id}: the tutorial never reached its closing card in ${MAX_STEPS} steps`,
  );
  return seen;
}
