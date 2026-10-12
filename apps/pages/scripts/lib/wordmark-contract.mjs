/**
 * The wordmark's decrypt, sampled from the real page: the slot timings it
 * publishes, one cursor cell at a time at an injected clock, and the settled
 * plates under reduced motion. The plates are a canvas, so the sample reads
 * `data-cipher-timings` and `data-cipher-cursor`, not CSS animations.
 */
export async function checkWordmark(page, check) {
  // Playwright accepts `:visible`; never pass that pseudo to querySelector.
  const wordmark = page.locator(".wordmark:visible").first();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await wordmark.evaluate((mark) => mark.getBoundingClientRect());

  const timings = await wordmark
    .locator(".cipher-wordmark")
    .getAttribute("data-cipher-timings");
  const slots = JSON.parse(timings ?? "[]");
  const letters = slots.filter((slot) => slot.letter !== " ");
  check(
    slots.length === 11 &&
      letters.length === 10 &&
      letters.every(
        (slot, index) =>
          slot.duration >= 210 &&
          slot.duration <= 420 &&
          Math.abs(
            slot.delay -
              letters
                .slice(0, index)
                .reduce((sum, entry) => sum + entry.duration, 0),
          ) < 0.000001,
      ),
    "wordmark decrypts ten letters with bounded variable durations strictly in sequence",
  );
  check(
    slots.map((slot) => slot.letter).join("") === "OPEN SESAME",
    "the plates spell OPEN SESAME",
  );

  // Pin the clock mid-way through the second letter and read the cursor.
  const cursor = await page.evaluate(async () => {
    const mark = [...document.querySelectorAll(".wordmark")].find((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    const root = mark?.querySelector(".cipher-wordmark");
    if (!root) return null;
    const timings = JSON.parse(root.dataset.cipherTimings ?? "[]");
    const letters = timings.filter((slot) => slot.letter !== " ");
    const start = Number(root.dataset.cipherStart ?? 0);
    const frames = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    // Pin the clock inside the second letter's window. A run that already
    // settled stopped its loop, so wake it the way a tab coming back does.
    window.__vt = start + letters[1].delay + letters[1].duration / 2;
    document.dispatchEvent(new Event("visibilitychange"));
    await frames();
    const at = root.dataset.cipherCursor;
    window.__vt = undefined;
    document.dispatchEvent(new Event("visibilitychange"));
    await frames();
    return { at, width: root.getBoundingClientRect().width };
  });
  check(
    cursor !== null && cursor.at === "1",
    `exactly one wordmark letter is decrypting at the injected clock${cursor ? ` (cursor on ${cursor.at})` : ""}`,
  );
  check(
    cursor !== null && cursor.width > 0,
    "the cipher wordmark canvas has a width",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  check(
    await wordmark
      .locator(".visually-hidden")
      .first()
      .textContent()
      .then((t) => t === "open-sesame"),
    "wordmark accessible name stays open-sesame",
  );
  const reduced = await wordmark.evaluate((mark) => {
    const cipher = mark.querySelector(".cipher-wordmark");
    return {
      settled: cipher?.classList.contains("cipher-wordmark--settled"),
      cursor: cipher?.dataset.cipherCursor,
    };
  });
  check(
    reduced.settled === true && reduced.cursor === "-1",
    `reduced motion shows the settled plates immediately${reduced.settled ? "" : `: ${JSON.stringify(reduced)}`}`,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
