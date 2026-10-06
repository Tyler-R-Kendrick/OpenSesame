// The phone's Add button (DESIGN.md § Layout): one sharp 56px square `+`, and
// the drag area a hold draws around it — slide up to Import, down to Export —
// walked with raw touch events through the browser's own input pipeline.

/** The Add button: one sharp 56px `+`, bottom right, above the prompt, no ellipsis. */
export async function fabIsPinned(page, label, harness) {
  const fab = await page.evaluate(() => {
    const node = document.querySelector(".fab");
    const add = node?.querySelector(".fab__add");
    if (!node || !add) return null;
    const box = node.getBoundingClientRect();
    const plus = add.getBoundingClientRect();
    const strip = document
      .querySelector(".statusline")
      ?.getBoundingClientRect();
    const corners = [node, add].map((el) => getComputedStyle(el).borderRadius);
    return {
      plus: `${Math.round(plus.width)}x${Math.round(plus.height)}`,
      square: Math.abs(plus.width - plus.height) <= 1,
      plusOk: plus.width >= 56 && plus.height >= 56,
      sharp: corners.every((radius) => radius === "0px"),
      alone: node.querySelectorAll("button").length === 0,
      right: Math.round(window.innerWidth - box.right),
      clearOfStrip: strip ? box.bottom <= strip.top + 1 : false,
      inRightHalf: box.left > window.innerWidth / 2,
      lowerHalf: box.top > window.innerHeight / 2,
      label: add.getAttribute("aria-label"),
    };
  });
  harness.check(
    fab !== null &&
      fab.label === "New item" &&
      fab.square &&
      fab.plusOk &&
      fab.sharp &&
      fab.alone &&
      fab.inRightHalf &&
      fab.lowerHalf &&
      fab.right >= 8 &&
      fab.right <= 24 &&
      fab.clearOfStrip,
    `${label}: Add is one sharp square + (56px), no ellipsis, bottom right, above the prompt (${JSON.stringify(fab)})`,
  );
}

/** What the drag area drew: each zone's label, ink, corners and whether it is on screen. */
const readDragArea = (page) =>
  page.evaluate(() => {
    const area = document.querySelector(".add-slide");
    if (!area) return null;
    return [...area.querySelectorAll(".add-slide__zone")].map((zone) => {
      const box = zone.getBoundingClientRect();
      const label = zone.querySelector(".add-slide__label");
      const chip = label?.getBoundingClientRect();
      return {
        way: zone.classList.contains("add-slide__zone--up") ? "up" : "down",
        label: label?.textContent?.trim(),
        active: zone.getAttribute("data-active") === "true",
        height: Math.round(box.height),
        sharp:
          getComputedStyle(zone).borderRadius === "0px" &&
          getComputedStyle(label).borderRadius === "0px",
        onScreen:
          box.top >= 0 && box.bottom <= window.innerHeight && chip.left >= 0,
      };
    });
  });

/**
 * Hold the Add button with a real finger (raw touch events through the
 * browser's input pipeline) and slide `by` px vertically before lifting; the
 * drag area is read at the end of the slide, before the lift.
 */
async function holdAndSlide(page, by) {
  const box = await page.locator(".fab__add").boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [at],
  });
  await page.waitForTimeout(700);
  const held = await readDragArea(page);
  let slid = held;
  if (by !== 0) {
    for (let step = 1; step <= 6; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: at.x, y: at.y + (by * step) / 6 }],
      });
      await page.waitForTimeout(30);
    }
    slid = await readDragArea(page);
  }
  return {
    held,
    slid,
    lift: async () => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForTimeout(500);
      await cdp.detach();
    },
  };
}

/** Holding the Add button: the drag area, what each slide chooses, and that a lift elsewhere chooses nothing. */
export async function addSlide(page, label, harness, { stop, audit }) {
  const where = () => page.evaluate(() => location.pathname);
  const before = await where();
  const names = (area) => (area ?? []).map((zone) => zone.label).join("|");

  // Held, not yet slid: the drag area is drawn and both zones are named.
  const rest = await holdAndSlide(page, 0);
  harness.check(
    names(rest.held) === "Import items|Export items" &&
      rest.held.every(
        (zone) => zone.height >= 28 && zone.sharp && zone.onScreen,
      ) &&
      rest.held.every((zone) => !zone.active),
    `${label}: holding the + draws the drag area, Import above and Export below, sharp and on screen (${JSON.stringify(rest.held)})`,
  );
  await audit(page, stop("add-slide"));
  await rest.lift();
  harness.check(
    (await page.locator(".add-slide").count()) === 0 &&
      (await where()) === before &&
      (await page.locator('[role="menu"]').count()) === 0,
    `${label}: letting go in the middle chooses nothing, opens no menu and does not follow the + (${await where()})`,
  );

  // Slide up: Import is inked, and letting go there opens the OS file picker.
  const up = await holdAndSlide(page, -70);
  harness.check(
    up.slid.find((zone) => zone.way === "up")?.active === true &&
      up.slid.find((zone) => zone.way === "down")?.active === false,
    `${label}: sliding up inks Import (${JSON.stringify(up.slid)})`,
  );
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null),
    up.lift(),
  ]);
  harness.check(
    chooser !== null,
    `${label}: letting go on Import starts the OS file picker`,
  );

  // Slide down: Export is inked, and letting go there opens its sheet.
  const down = await holdAndSlide(page, 70);
  harness.check(
    down.slid.find((zone) => zone.way === "down")?.active === true &&
      down.slid.find((zone) => zone.way === "up")?.active === false,
    `${label}: sliding down inks Export (${JSON.stringify(down.slid)})`,
  );
  await down.lift();
  const sheet = await page
    .getByRole("dialog", { name: "Export encrypted vault" })
    .count();
  harness.check(
    sheet === 1,
    `${label}: letting go on Export opens the export sheet (${sheet})`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // The default is still one tap: the + goes to the editor.
  await page.locator(".fab__add").tap();
  await page.waitForTimeout(600);
  harness.check(
    (await where()).endsWith("/vault/new"),
    `${label}: a tap on the + opens the editor (${await where()})`,
  );
  await page.goBack();
  await page.waitForTimeout(500);
}
