/** Sample the real CSS timeline; only one character lock may move at a time. */
export async function checkWordmark(page, check) {
  const wordmark = page.locator(".wordmark:visible").first();
  // Earlier first-load checks may outlast the reveal; restart its CSS timeline.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await wordmark.evaluate((mark) => getComputedStyle(mark).display);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const timeline = await wordmark.evaluate((mark) => {
    const slots = [...mark.querySelectorAll(".wordmark__slot")];
    const animations = slots.map((slot) => slot.getAnimations()[0]);
    for (const animation of mark.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime =
        Number(animations[0].effect.getTiming().duration) / 2;
    }
    return {
      timings: animations.map((animation) => animation?.effect.getTiming()),
      moving: animations.filter((animation) => {
        const progress = animation?.effect.getComputedTiming().progress;
        return progress > 0 && progress < 1;
      }).length,
      slots: slots.map((slot) => ({
        width: slot.getBoundingClientRect().width,
        background: getComputedStyle(slot).backgroundColor,
      })),
    };
  });
  check(
    timeline.timings.length === 11 &&
      timeline.timings.every(
        (timing, index) =>
          timing.duration >= 210 &&
          timing.duration <= 420 &&
          // CSS seconds round-trip through binary floats (1015ms can become
          // 1014.9999999999999). Keep the sequence exact to a nanosecond.
          Math.abs(
            timing.delay -
              timeline.timings
                .slice(0, index)
                .reduce((sum, entry) => sum + entry.duration, 0),
          ) < 0.000001,
      ),
    "wordmark decrypts eleven slots with bounded variable durations strictly in sequence",
  );
  check(timeline.moving === 1, "only one wordmark character is decrypting");
  check(
    timeline.slots.every(
      (slot) => slot.width > 0 && slot.background !== "rgba(0, 0, 0, 0)",
    ),
    "every character has a visible slot background",
  );
  // Reduced motion is judged on a fresh load, the way a person who asked for
  // it arrives: a CSS animation this check paused by hand above stays owned
  // by the Web Animations API, and a paused one survives `animation-name:
  // none` in Chromium — which is the sampler's doing, not the wordmark's.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  const reduced = await wordmark.evaluate((mark) =>
    [...mark.querySelectorAll(".wordmark__slot")].map((slot) => {
      const last = slot.querySelector(".wordmark__glyph:last-child");
      return {
        slotAnimation: getComputedStyle(slot).animationName,
        reelAnimation: getComputedStyle(slot.firstElementChild).animationName,
        animations: slot.getAnimations({ subtree: true }).map((animation) => ({
          state: animation.playState,
          type: animation.constructor.name,
          target: animation.effect.target.className,
          property: animation.transitionProperty,
        })),
        offset: last.getBoundingClientRect().y - slot.getBoundingClientRect().y,
      };
    }),
  );
  check(
    await wordmark
      .locator(".wordmark__glyph:last-child")
      .allTextContents()
      .then((letters) => letters.join("") === "open-sesame"),
    "wordmark settles on open-sesame including its hyphen",
  );
  const failed = reduced.filter(
    (slot) =>
      slot.slotAnimation !== "none" ||
      slot.reelAnimation !== "none" ||
      slot.animations.length !== 0 ||
      Math.abs(slot.offset) >= 0.6,
  );
  check(
    failed.length === 0,
    `reduced motion shows the plaintext immediately${failed.length ? `: ${JSON.stringify(failed)}` : ""}`,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
