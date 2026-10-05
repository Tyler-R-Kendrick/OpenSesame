/**
 * The two ways a person works a tour that Next alone never touches: leaving it
 * with Escape, and making the move a step is waiting for. Each is done to a
 * real tutorial in a real browser, through the same keys and the same pointer
 * a person has, so a card that swallows a key or a dim that blocks the
 * aperture cannot pass.
 */

import {
  advancedFrom,
  readStep,
  resetToVault,
  startTutorial,
  unlockIfLocked,
} from "./tutorial-walk.mjs";

const gone = (page, timeout = 4000) =>
  page
    .waitForFunction(() => !document.querySelector(".coach"), undefined, {
      timeout,
    })
    .then(
      () => true,
      () => false,
    );

async function beginAt(page, { base, id }) {
  await resetToVault(page, base);
  await unlockIfLocked(page);
  await startTutorial(page, id);
  return readStep(page);
}

/** Puts focus on the real control a step points at; says whether it took. */
function focusControl(page, target) {
  return page.evaluate((id) => {
    const control = [
      ...document.querySelectorAll(`[data-guide-targets~="${id}"]`),
    ].find((node) => node.getClientRects().length > 0);
    if (!control) return false;
    control.focus();
    return document.activeElement === control;
  }, target);
}

/** Ends the tour if it is still up, then closes what a move opened (`opened`). */
async function leave(page, opened = null) {
  for (let presses = 0; presses < 4; presses += 1) {
    if (await gone(page, 300)) break;
    await page.keyboard.press("Escape");
  }
  if (opened === null) return true;
  // The list closes on a press outside it, the way a person dismisses it.
  if (await opened.isVisible())
    await page
      .locator(".project-switcher__backdrop")
      .click({ position: { x: 4, y: 4 } });
  return opened.waitFor({ state: "hidden", timeout: 3000 }).then(
    () => true,
    () => false,
  );
}

/**
 * Escape ends the tour with focus on the card, and again with focus on the
 * control the tour is lighting — the key a person reaches for in either place.
 * Uses `vault.lock`: its first step is a card with nothing lit, its second
 * points at the lock.
 */
export async function escapeEndsTheTour(page, { check, base }) {
  const id = "vault.lock";
  const first = await beginAt(page, { base, id });
  check(Boolean(first?.focusInCard), `${id}: focus starts on the card`);
  await page.keyboard.press("Escape");
  check(await gone(page), `${id}: Escape on the card ends the tour`);

  const opening = await beginAt(page, { base, id });
  if (!opening) return check(false, `${id}: the tutorial opens a card`);
  await page.locator(".coach__btn--go").click();
  check(await advancedFrom(page, opening), `${id}: Next reaches the lit step`);
  const lit = await readStep(page);
  const focused = lit?.target ? await focusControl(page, lit.target) : false;
  check(focused, `${id}: the lit control (${lit?.target}) can take focus`);
  await page.keyboard.press("Escape");
  check(await gone(page), `${id}: Escape on the lit control ends the tour`);
  await leave(page);
}

/**
 * A step that waits for the person's move advances when the move is made on
 * the lit control through the aperture. `vaults.switch` waits for the tomb
 * segment to be pressed, which only opens the list of vaults.
 */
export async function moveAdvancesTheTour(page, { check, base }) {
  const id = "vaults.switch";
  let info = await beginAt(page, { base, id });
  for (let steps = 0; info && !info.action && steps < 6; steps += 1) {
    await page.locator(".coach__btn--go").click();
    if (!(await advancedFrom(page, info))) break;
    info = await readStep(page);
  }
  check(Boolean(info?.action), `${id}: a step waits for the person's move`);
  const opened = page.locator(".project-switcher__menu");
  if (!info?.action || !info.probe?.visible) {
    await leave(page, opened);
    return;
  }
  await page.mouse.click(info.probe.x, info.probe.y);
  check(
    await advancedFrom(page, info),
    `${id}: making the move on ${info.target} through the aperture advances the tour`,
  );
  check(
    await leave(page, opened),
    `${id}: the list the move opened can be dismissed`,
  );
}
