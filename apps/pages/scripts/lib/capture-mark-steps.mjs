/**
 * Capture verbs for a status mark's touch twin (DESIGN.md § Status is a
 * symbol): tap a mark the way a finger or a mouse does, or hold it the way a
 * finger does, so a sheet shows what reading a refusal by touch looks like —
 * in the base build as well, where neither gesture answers.
 */

/** The first status mark in the page's main content, by its sentence. */
function firstMark(page) {
  return page.locator("main .status-mark").first();
}

async function centre(locator, verb) {
  if (!(await locator.count()))
    throw new Error(
      `capture-evidence ${verb}: no status mark in main — refusing a silent miss`,
    );
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function markSteps({ press }) {
  return {
    /** A plain tap (a click, on a desktop capture) on the first mark. */
    async tapMark(page) {
      const mark = firstMark(page);
      await centre(mark, "tapMark");
      await press(mark);
      await page.waitForTimeout(300);
    },
    /**
     * A finger held still on the first mark for 700ms, then lifted. Playwright
     * has a tap but no hold, so the touch is sent through the protocol the
     * browser itself receives it by.
     */
    async holdMark(page) {
      const point = await centre(firstMark(page), "holdMark");
      const cdp = await page.context().newCDPSession(page);
      const touchPoints = [{ x: point.x, y: point.y }];
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints,
      });
      await page.waitForTimeout(700);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.detach();
      await page.waitForTimeout(200);
    },
    /** What the bubble says, if anything is showing. */
    async bubble(page) {
      const texts = await page.locator(".status-bubble").allInnerTexts();
      console.log(`  bubble: ${texts.join(" | ") || "none"}`);
    },
  };
}
