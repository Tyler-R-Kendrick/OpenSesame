/**
 * What a refusal looks like on these screens, and nothing else it may look
 * like (DESIGN.md § Status is a symbol, ADR 0157): an error mark on the
 * control that failed, whose sentence is its accessible name and its tooltip,
 * and the same sentence as a notice in the tray. Never text in the page, never
 * a visible alert, never a red box.
 *
 * A sheet hides the bell behind its scrim, so the notice is read in two
 * halves: while the sheet is open the bell says something is pending, and
 * when the person closes the sheet the tray is opened and every sentence the
 * marks carried is found in it (`settleTray`).
 */

import { expect } from "./tc-expect.mjs";

const TRAY = "Notifications";

/** The error marks in `scope`, whose sentence matches `name` when one is given. */
export function errorMarks(scope, name) {
  const marks = name
    ? scope.getByRole("img", { name })
    : scope.getByRole("img");
  return marks.and(scope.locator(".status-mark--err"));
}

/** The tray's sheet. */
export const tray = (page) =>
  page.getByRole("dialog", { name: TRAY, exact: true });

/**
 * The page's text with the tray's own sheet taken out: the tray is where a
 * failure is read, so only what is outside it must stay free of the sentence.
 */
export function pageTextOutsideTray(page) {
  return page.evaluate((name) => {
    const clone = document.body.cloneNode(true);
    for (const node of clone.querySelectorAll(
      `[role="dialog"][aria-label="${name}"]`,
    ))
      node.remove();
    return clone.textContent ?? "";
  }, TRAY);
}

/** Alerts and error boxes the page itself draws: the tray's own cards are not the page. */
export function strayFailureBoxes(page) {
  return page.evaluate((name) => {
    const boxes = document.querySelectorAll(
      '[role="alert"], .note--err, .conn-error, .conn-flash, .broker__card--err',
    );
    return [...boxes]
      .filter((node) => !node.closest(`[role="dialog"][aria-label="${name}"]`))
      .map((node) => (node.textContent ?? "").trim().slice(0, 120));
  }, TRAY);
}

/** The page draws no failure of its own: no alert, no box, and the sentence is in no text. */
export async function expectNoFailureInPage(page, sentence) {
  expect(await strayFailureBoxes(page), "no alert or error box").toEqual([]);
  if (sentence) {
    expect(
      await pageTextOutsideTray(page),
      "the sentence is not written in the page",
    ).not.toContain(sentence);
  }
}

/**
 * How many notices the bell says are pending. The bell is in the page at every
 * width (a phone hides it behind its More key), so its label is the count.
 */
export async function trayCount(page) {
  const label = await page
    .locator('button[aria-label^="Notifications — "]')
    .first()
    .getAttribute("aria-label");
  const found = /(\d+) pending/.exec(label ?? "");
  return found ? Number(found[1]) : 0;
}

/** Open the tray the way this width draws it: the statusline's bell, or a phone's More key. */
export async function openTray(page) {
  const bell = page
    .getByRole("button", { name: /^Notifications — / })
    .filter({ visible: true });
  if ((await bell.count()) > 0) {
    await bell.first().click();
  } else {
    await page.getByRole("button", { name: /^More — / }).click();
    await page
      .getByRole("button", { name: /^Notifications/ })
      .last()
      .click();
  }
  const sheet = tray(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Every sentence the tray holds as an error, dismissed and the sheet closed. */
export async function drainTray(page) {
  const sheet = await openTray(page);
  await expect(sheet.locator("article.notice-card--err").first()).toBeVisible();
  const sentences = (
    await sheet.locator("article.notice-card--err p").allInnerTexts()
  ).map((text) => text.replace(/\s+/g, " ").trim());
  const dismiss = sheet.getByRole("button", { name: "Dismiss" });
  while ((await dismiss.count()) > 0) await dismiss.first().click();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  return sentences;
}

/** Read the tray once a sheet is closed: every refusal the person was shown is in it, then it is emptied. */
export async function settleTray(person) {
  if (person.owed.length === 0) return;
  const sentences = await drainTray(person.page);
  for (const owed of person.owed) {
    expect(sentences, `${person.name}: the tray holds "${owed}"`).toContain(
      owed,
    );
  }
  person.owed = [];
  await expect.poll(() => trayCount(person.page)).toBe(0);
}

/**
 * A step that failed: the mark on the control carries the sentence as its name
 * and as its tooltip, the bell says one is pending, and the page itself says
 * nothing in text. The sentence is owed to the tray, which is read when the
 * sheet closes. Returns the sentence.
 */
export async function expectRefusal(person, { mark, scope = person.page }) {
  const { page } = person;
  const found = errorMarks(scope, mark).first();
  await expect(
    found,
    "the control that failed carries an error mark",
  ).toBeVisible();
  const sentence = await found.getAttribute("aria-label");
  expect(await found.getAttribute("title"), "the tooltip is the sentence").toBe(
    sentence,
  );
  await expect
    .poll(() => trayCount(page), "the bell has it")
    .toBeGreaterThan(0);
  await expectNoFailureInPage(page, sentence);
  person.owed.push(sentence);
  person.harness.record("REFUSAL", `${person.name}: ${sentence}`);
  return sentence;
}

/**
 * A retry that worked takes its notice with it: the failure is cleared when the
 * same step next runs, and so is its card in the tray. The sentence is no
 * longer owed, and the bell has let go of it.
 */
export async function expectNoticeCleared(person, sentence) {
  person.owed = person.owed.filter((owed) => owed !== sentence);
  const left = person.owed.length;
  await expect
    .poll(() => trayCount(person.page), "the retry that worked took its notice")
    .toBeLessThanOrEqual(left);
  if (left === 0) expect(await trayCount(person.page)).toBe(0);
}

/**
 * A paste a field refuses as it is pasted, or a draft the desk judges as it is
 * edited: a mark with the sentence (on the field, when there is one, and the
 * field invalid), the key that would go on off. A half-typed packet is not a
 * failure, so the tray gets nothing from it and nothing is begun. Returns the
 * sentence.
 */
export async function expectLiveRefusal(person, { field, key, mark, scope }) {
  const { page } = person;
  if (field) {
    await expect(scope.getByLabel(field, { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  }
  const found = errorMarks(scope, mark).first();
  await expect(found).toBeVisible();
  const sentence = await found.getAttribute("aria-label");
  expect(await found.getAttribute("title")).toBe(sentence);
  await expect(person.key(key, scope), "its key stays off").toBeDisabled();
  expect(
    await trayCount(page),
    "a refusal made as it is pasted is not a notice",
  ).toBeLessThanOrEqual(person.owed.length);
  await expectNoFailureInPage(page, sentence);
  person.harness.record("LIVE-REFUSAL", `${person.name}: ${sentence}`);
  return sentence;
}
