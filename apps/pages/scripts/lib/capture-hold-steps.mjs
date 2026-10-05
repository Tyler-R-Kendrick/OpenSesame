/**
 * Capture verbs for a finger held on a link: the phone's Add button, held and
 * slid. They drive raw touch events through the browser's own input pipeline
 * (CDP), so the app's recognizer sees what a thumb would make, and the finger
 * stays down across the steps between `holdLink` and `releaseHeld` — a `shot` in the
 * middle shows what the hold drew.
 */

export function holdSteps() {
  /** The finger now down on each page: its session and where it landed. */
  const down = new WeakMap();
  const send = (finger, type, y) =>
    finger.cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: finger.x, y }],
    });
  return {
    /**
     * `{ "holdLink": { "link": "New item", "ms": 700 } }` — put a finger on the
     * named link and keep it there. A link the build does not have is a miss.
     */
    async holdLink(page, { link, ms = 700 }) {
      const box = await page
        .getByRole("link", { name: link, exact: true })
        .first()
        .boundingBox();
      if (!box)
        throw new Error(
          `capture-evidence holdLink("${link}"): no such link — refusing a silent miss`,
        );
      const finger = {
        cdp: await page.context().newCDPSession(page),
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      };
      down.set(page, finger);
      await send(finger, "touchStart", finger.y);
      await page.waitForTimeout(ms);
    },
    /** `{ "slideHeld": -70 }` — drag the held finger this many px from where it landed. */
    async slideHeld(page, by) {
      const finger = down.get(page);
      if (!finger)
        throw new Error("capture-evidence slideHeld: no finger is down");
      for (let step = 1; step <= 6; step++) {
        await send(finger, "touchMove", finger.y + (by * step) / 6);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(250);
    },
    /** `{ "corners": ".fab" }` — print each match's box and computed corner radius. */
    async corners(page, selector) {
      const found = await page.locator(selector).evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          const radius = getComputedStyle(node).borderRadius;
          return `${node.className.split(" ")[0]} ${Math.round(box.width)}x${Math.round(box.height)} radius ${radius}`;
        }),
      );
      console.log(`  corners ${selector}: ${found.join(" | ") || "none"}`);
    },
    /** `{ "releaseHeld": null }` — lift the finger. */
    async releaseHeld(page) {
      const finger = down.get(page);
      if (!finger) return;
      await send(finger, "touchEnd", finger.y);
      await finger.cdp.detach();
      down.delete(page);
      await page.waitForTimeout(600);
    },
  };
}
