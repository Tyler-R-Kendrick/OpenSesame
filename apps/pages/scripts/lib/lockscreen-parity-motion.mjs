/** Fingerprint actual canvas paints; this renderer rotates glyphs inside canvas. */
export function dialFrame() {
  return [...document.querySelectorAll(".cipher-dial__ring")].map((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 2) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]) ink++;
      hash = Math.imul(hash ^ data[i], 16777619);
    }
    return {
      hash: hash >>> 0,
      ink,
      transform: getComputedStyle(canvas).transform,
    };
  });
}

function heroFrame() {
  const canvas = document.querySelector(".unlock__hero canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return null;
  const data = canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++)
    hash = Math.imul(hash ^ data[i], 16777619);
  return hash >>> 0;
}

export async function measureIdleMotion(page, reduced) {
  const frames = [await page.evaluate(dialFrame)];
  const heroFrames = [await page.evaluate(heroFrame)];
  await page.waitForTimeout(reduced ? 400 : 750);
  frames.push(await page.evaluate(dialFrame));
  heroFrames.push(await page.evaluate(heroFrame));
  await page.waitForTimeout(reduced ? 400 : 1650);
  frames.push(await page.evaluate(dialFrame));
  heroFrames.push(await page.evaluate(heroFrame));
  const changed = frames[0].map((ring, index) =>
    Boolean(ring && frames.some((frame) => frame[index]?.hash !== ring.hash)),
  );
  return {
    reduced,
    changedRings: changed.filter(Boolean).length,
    frames,
    heroFrames,
    heroChanged: heroFrames.some((frame) => frame !== heroFrames[0]),
  };
}

/** Observe real door progress while submitting the real device PIN. */
export async function observeDoors(page, pin, screenshot) {
  await page.evaluate(() => {
    const pane = document.querySelector(".unlock");
    window.__lockscreenDoorSamples = [];
    const observer = new MutationObserver(() => {
      if (!pane.classList.contains("unlock--doors")) return;
      const shift = Number.parseFloat(
        pane.style.getPropertyValue("--unlock-door-shift"),
      );
      window.__lockscreenDoorSamples.push({ at: performance.now(), shift });
    });
    observer.observe(pane, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    window.__lockscreenDoorObserver = observer;
  });
  await page.getByLabel("PIN", { exact: true }).fill(pin);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForFunction(() =>
    window.__lockscreenDoorSamples.some((sample) => sample.shift > 5),
  );
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: false });
  await page.locator(".unlock").waitFor({ state: "detached", timeout: 15000 });
  const samples = await page.evaluate(() => {
    window.__lockscreenDoorObserver.disconnect();
    return window.__lockscreenDoorSamples;
  });
  return {
    samples,
    shifts: [
      ...new Set(samples.map((sample) => sample.shift).filter(Number.isFinite)),
    ],
  };
}
