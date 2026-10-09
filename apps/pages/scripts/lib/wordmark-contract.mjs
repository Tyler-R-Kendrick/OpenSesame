/** Sample decrypt timing via data-cipher-timings; one cursor cell at a time. */
export async function checkWordmark(page, check) {
  // Playwright accepts `:visible`; never pass that pseudo to querySelector.
  const wordmark = page.locator(".wordmark:visible").first();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await wordmark.evaluate((mark) => mark.getBoundingClientRect());

  const timings = await wordmark
    .locator(".cipher-wordmark")
    .getAttribute("data-cipher-timings");
  const slots = JSON.parse(timings ?? "[]");
  check(
    slots.length >= 10 &&
      slots
        .filter((slot) => slot.letter !== " ")
        .every(
          (slot, index, list) =>
            slot.duration >= 210 &&
            slot.duration <= 420 &&
            Math.abs(
              slot.delay -
                list
                  .slice(0, index)
                  .reduce((sum, entry) => sum + entry.duration, 0),
            ) < 0.000001,
        ),
    "wordmark decrypts slots with bounded variable durations strictly in sequence",
  );

  const moving = await page.evaluate(() => {
    const marks = [...document.querySelectorAll(".wordmark")];
    const mark = marks.find((node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    const canvas = mark?.querySelector("canvas");
    if (!mark || !canvas) return -1;
    const timings = JSON.parse(
      mark.querySelector(".cipher-wordmark")?.dataset.cipherTimings ?? "[]",
    );
    const letters = timings.filter((s) => s.letter !== " ");
    const mid =
      letters[0].delay + letters[0].duration / 2 + letters[1].delay / 2;
    window.__vt = mid;
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const roots = [...mark.querySelectorAll(".cipher-wordmark")];
          const active = roots.filter((root) =>
            root.classList.contains("cipher-wordmark--settled"),
          ).length;
          resolve(active);
        });
      });
    });
  });
  check(moving !== -1, "cipher wordmark canvas is present for sampling");

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
      motion: getComputedStyle(cipher ?? mark).animationName,
    };
  });
  check(
    reduced.settled === true,
    `reduced motion shows the settled cipher immediately${reduced.settled ? "" : `: ${JSON.stringify(reduced)}`}`,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
