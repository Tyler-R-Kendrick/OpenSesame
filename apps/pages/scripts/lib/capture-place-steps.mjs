/**
 * Capture verbs that bring a place into view when the two builds draw it
 * differently — a heading in one and a row title in the other, a
 * disclosure one build has and the other does not — kept beside
 * `capture-evidence.mjs`'s own.
 */
export function placeSteps() {
  return { reveal, openDetails };
}

/**
 * Bring the first label, heading or summary reading exactly `text` near the
 * top — for a place one build draws as a heading and the other as a row
 * title. Skipped when neither build has it. It stops 140px short of the top,
 * so a sticky strip (the phone's section chips) never covers the heading.
 */
export async function reveal(page, text) {
  const target = page
    .locator("h2, h3, strong, summary")
    .filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) })
    .first();
  if (!(await target.count())) return;
  await target.evaluate((node) => {
    node.scrollIntoView({ block: "start", behavior: "instant" });
    let pane = node.parentElement;
    while (pane && pane.scrollHeight <= pane.clientHeight) {
      pane = pane.parentElement;
    }
    (pane ?? document.scrollingElement)?.scrollBy(0, -140);
  });
  await page.waitForTimeout(600);
}

/** Open a disclosure (`<details>`) by test id, when this build has one. */
export async function openDetails(page, testId) {
  const details = page.getByTestId(testId);
  if (!(await details.count())) return;
  if (await details.evaluate((node) => node.open)) return;
  await details.locator("summary").first().click();
  await page.waitForTimeout(600);
}
