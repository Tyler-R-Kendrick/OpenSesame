/**
 * Settings › Keybindings on a phone (ADR 0164, DESIGN.md § Touch).
 *
 * A finger has no key to press, so a phone's keymap leads with gestures: the
 * page is drawn on every device, opens on its Gestures tab, keeps the Keyboard
 * tab one tap away, and every gesture's choice is a 44px target set at 16px
 * or more. Then the gestures are made the way a hand makes them, with real
 * multi-touch events (CDP, so the page sees `touches` and Chromium runs its
 * own scroll and fling detection too), and each must do what its row says:
 *
 * - a shake (a real `devicemotion` run) asks for the help sheet;
 * - a two-finger tap, once bound to the help sheet in the panel itself, opens
 *   it, and does nothing while a field holds the screen;
 * - a two-finger swipe in the section tree runs its default, and is claimed
 *   (the page does not also scroll under it).
 */

const GESTURE_ROWS = [
  "two-finger-swipe-left",
  "two-finger-swipe-right",
  "two-finger-swipe-up",
  "two-finger-swipe-down",
  "two-finger-tap",
  "shake",
];

/** What the Gestures page measures about itself, in one round trip. */
const PAGE = `(() => {
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
    name: (tab.textContent ?? "").trim(),
    selected: tab.getAttribute("aria-selected") === "true",
    ...box(tab),
  }));
  const choices = [...document.querySelectorAll(".kb-target")].map((node) => ({
    row: node.closest("[data-gesture]")?.getAttribute("data-gesture") ?? null,
    size: parseFloat(getComputedStyle(node).fontSize),
    ...box(node),
  }));
  return {
    pathname: location.pathname,
    tabs,
    choices,
    rows: [...document.querySelectorAll("[data-gesture]")].map((row) =>
      row.getAttribute("data-gesture"),
    ),
    overflow: document.documentElement.scrollWidth - innerWidth,
    heading: document.querySelector("h2")?.textContent ?? null,
  };
})()`;

/** Fingers at `points`, all down together (`id` keeps each one its own). */
function fingers(points) {
  return points.map(([x, y], id) => ({
    x: Math.round(x),
    y: Math.round(y),
    id,
  }));
}

/** Two fingers side by side at (x, y), 80px apart, travelling by `by` in `steps`. */
async function twoFingers(page, [x, y], by, { steps = 6, hold = 0 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const at = (k) => [
    [x + (by[0] * k) / steps, y + (by[1] * k) / steps],
    [x + 80 + (by[0] * k) / steps, y + (by[1] * k) / steps],
  ];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: fingers(at(0)),
  });
  if (hold > 0) await page.waitForTimeout(hold);
  for (let k = 1; k <= steps && (by[0] !== 0 || by[1] !== 0); k++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: fingers(at(k)),
    });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  await page.waitForTimeout(350);
}

/** A shake: hard jolts the detector's own spacing apart, as the sensor sends them. */
async function shake(page) {
  await page.evaluate(`window.__reading = (x) =>
    window.dispatchEvent(
      new DeviceMotionEvent("devicemotion", {
        accelerationIncludingGravity: { x, y: 0, z: 9.8 },
      }),
    )`);
  await page.evaluate("window.__reading(0)");
  for (let jolt = 0; jolt < 6; jolt++) {
    await page.waitForTimeout(140);
    await page.evaluate(`window.__reading(${jolt % 2 === 0 ? 40 : -40})`);
  }
  await page.waitForTimeout(450);
}

const sheetOpen = (page) =>
  page.getByRole("dialog", { name: "Gestures" }).count();

async function closeSheet(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
}

/** The Keybindings tab, reached the way a thumb reaches it. */
async function openKeybindings(page) {
  const link = page
    .locator('nav[aria-label="Settings sections"] a', {
      hasText: /^Keybindings$/,
    })
    .first();
  if ((await link.count()) === 0) return false;
  await link.scrollIntoViewIfNeeded();
  await link.tap();
  await page.waitForTimeout(900);
  return true;
}

async function pageContract(page, harness, label, audit) {
  const { check } = harness;
  const seen = await page.evaluate(PAGE);
  check(
    /\/settings\/keybindings/.test(seen.pathname),
    `${label}: Keybindings is on the phone (at ${seen.pathname})`,
  );
  check(
    seen.tabs.map((tab) => tab.name).join() === "Keyboard,Gestures",
    `${label}: both loadouts are tabs (${seen.tabs.map((tab) => tab.name).join(", ")})`,
  );
  check(
    seen.tabs.find((tab) => tab.selected)?.name === "Gestures",
    `${label}: a finger lands on Gestures`,
  );
  for (const tab of seen.tabs) {
    check(
      tab.h >= 44,
      `${label}: the ${tab.name} tab is ${tab.h}px tall, 44 or more`,
    );
  }
  check(
    seen.rows.join() === GESTURE_ROWS.join(),
    `${label}: one row per gesture (${seen.rows.join(", ")})`,
  );
  for (const choice of seen.choices) {
    check(
      choice.h >= 44,
      `${label}: ${choice.row}'s choice is ${choice.h}px tall`,
    );
    check(
      choice.size >= 16,
      `${label}: ${choice.row}'s choice is set at ${choice.size}px: iOS would zoom`,
    );
  }
  check(
    seen.overflow <= 0,
    `${label}: the page is ${seen.overflow}px wider than the screen`,
  );
  await audit(page, label);
}

/** Bind the two-finger tap to help in the panel itself, as a person does. */
async function bindTapToHelp(page, harness, label) {
  const choice = page.locator('[data-gesture="two-finger-tap"] select');
  await choice.selectOption("help.keymap");
  await page.waitForTimeout(300);
  harness.check(
    (await choice.inputValue()) === "help.keymap",
    `${label}: the two-finger tap is bound to the keyboard help in the panel`,
  );
  await page
    .locator("h2", { hasText: /^Gestures$/ })
    .first()
    .tap();
  await page.waitForTimeout(200);
}

async function motionRuns(page, harness, label) {
  const { check } = harness;
  await shake(page);
  check(
    (await sheetOpen(page)) > 0,
    `${label}: a real shake opens the gestures sheet`,
  );
  await closeSheet(page);
  await twoFingers(page, [60, 400], [0, 0], { hold: 80 });
  check(
    (await sheetOpen(page)) > 0,
    `${label}: two fingers tapping open the gestures sheet`,
  );
  await closeSheet(page);
  // A field holds the screen: the same tap is not a gesture then.
  const field = page.locator("select.kb-target").first();
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  await twoFingers(page, [box.x + 12, box.y + box.height / 2], [0, 0], {
    hold: 80,
  });
  check(
    (await sheetOpen(page)) === 0,
    `${label}: a two-finger tap does nothing while a field holds the keyboard`,
  );
  await page.evaluate("document.activeElement?.blur()");
}

/** A two-finger swipe in the section tree runs its default, and the page is not also scrolled. */
async function swipeRuns(page, harness, label) {
  const { check } = harness;
  const tree = page.locator(".railtree").first();
  if ((await tree.count()) === 0) {
    check(false, `${label}: the section tree is not on screen`);
    return;
  }
  await tree.scrollIntoViewIfNeeded();
  const box = await tree.boundingBox();
  if (!box) {
    check(false, `${label}: the section tree has no box`);
    return;
  }
  const state = () =>
    page.evaluate(
      `JSON.stringify([location.pathname, document.querySelector(".railtree")?.getAttribute("aria-activedescendant") ?? null])`,
    );
  const before = await state();
  const scrolled = await page.evaluate("window.scrollY");
  const y = box.y + Math.min(box.height / 2, 120);
  await twoFingers(page, [Math.max(box.x + 24, 24), y], [0, -90]);
  const after = await state();
  check(
    before !== after,
    `${label}: a two-finger swipe up in the tree runs its action (${before} → ${after})`,
  );
  check(
    (await page.evaluate("window.scrollY")) === scrolled,
    `${label}: the swipe is the page's whole: nothing scrolled under it`,
  );
}

export async function auditGestures(page, harness, stop, audit) {
  const label = stop("settings-gestures");
  if (!(await openKeybindings(page))) {
    harness.check(false, `${label}: no Keybindings tab on the phone`);
    return;
  }
  await pageContract(page, harness, label, audit);
  await bindTapToHelp(page, harness, label);
  await motionRuns(page, harness, label);
  // The section tree is the vault's first pane. The router is told in place:
  // a reload would lock the vault this walk is inside.
  await page.evaluate(() => {
    history.pushState(
      null,
      "",
      `${location.pathname.replace(/settings.*$/, "")}vault`,
    );
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForTimeout(900);
  await swipeRuns(page, harness, label);
}
