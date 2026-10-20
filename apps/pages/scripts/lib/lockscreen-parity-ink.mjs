/** Canvas alpha is measured before CSS attenuation; the screenshot checks the composite. */
export function dialInk() {
  const alpha = (selector) => {
    const canvas = document.querySelector(selector);
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 2) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = new Array(256).fill(0);
    for (let i = 3; i < data.length; i += 4) counts[data[i]]++;
    const nonzero = data.length / 4 - counts[0];
    let max = 255;
    while (max > 0 && counts[max] === 0) max--;
    return {
      maxAlpha: max,
      inkPixels: nonzero,
      pixels: data.length / 4,
      transformScale: ctx.getTransform().a,
    };
  };
  const rings = document.querySelector(".cipher-dial__rings");
  const overlay = document.querySelector(".cipher-dial__overlay");
  return {
    overlay: alpha(".cipher-dial__overlay"),
    fixed: alpha(".cipher-dial__fixed"),
    firstRing: alpha(".cipher-dial__ring"),
    ringInkPixels: [...document.querySelectorAll(".cipher-dial__ring")].reduce(
      (sum, canvas) => {
        let count = 0;
        const data = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i]) count++;
        return sum + count;
      },
      0,
    ),
    ringLayerOpacity: rings ? Number(getComputedStyle(rings).opacity) : null,
    deviceScale: devicePixelRatio,
    overlayOpacity: overlay ? Number(getComputedStyle(overlay).opacity) : null,
  };
}

/** Decode a real screenshot using the browser's image decoder, without changing the DOM. */
async function screenshotContrast({ bytes, geometry }) {
  const image = await createImageBitmap(
    new Blob([new Uint8Array(bytes)], { type: "image/png" }),
  );
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  const scale = image.width / geometry.viewport.width;
  const luminance = (r, g, b) => {
    const linear = (value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return (
      0.2126 * linear(r / 255) +
      0.7152 * linear(g / 255) +
      0.0722 * linear(b / 255)
    );
  };
  const index = (x, y) =>
    (Math.floor(y * scale) * image.width + Math.floor(x * scale)) * 4;
  const bgIndex = index(8, 8);
  const background = luminance(
    data[bgIndex],
    data[bgIndex + 1],
    data[bgIndex + 2],
  );
  const { width, height } = geometry.viewport;
  const cx = width / 2;
  const cy = height * 0.493;
  const radius = Math.min(height * 0.465, cx * 0.78);
  const x0 = Math.max(10, cx - radius - 20);
  const x1 = cx - 8;
  const y0 = Math.max(8, cy - radius - 15);
  const y1 = Math.min(geometry.hero.y - 12, cy - radius + 100);
  const contrasts = [];
  for (let y = y0; y < y1; y += 2)
    for (let x = x0; x < x1; x += 2) {
      const i = index(x, y);
      const value = luminance(data[i], data[i + 1], data[i + 2]);
      contrasts.push(
        (Math.max(value, background) + 0.05) /
          (Math.min(value, background) + 0.05),
      );
    }
  contrasts.sort((a, b) => a - b);
  image.close();
  return {
    backgroundLuminance: background,
    roi: { x0, y0, x1, y1 },
    samples: contrasts.length,
    p99: contrasts[Math.floor(contrasts.length * 0.99)] ?? null,
    maximum: contrasts.at(-1) ?? null,
  };
}

export async function measureDialInk(page, geometry) {
  const ink = await page.evaluate(dialInk);
  if (geometry.viewport.width < 1100) return { ...ink, contrast: null };
  const png = await page.screenshot({ fullPage: false });
  return {
    ...ink,
    contrast: await page.evaluate(screenshotContrast, {
      bytes: [...png],
      geometry,
    }),
  };
}

export function checkDialInk(ink, check) {
  check(
    ink.fixed && Math.abs(ink.fixed.transformScale - ink.deviceScale) < 0.01,
    "fixed bezel uses the actual device pixel ratio",
  );
  check(
    ink.overlay && ink.overlay.inkPixels === 0,
    "idle overlay has no foreground index/readout ink",
  );
  check(ink.ringInkPixels > 100, "cipher glyphs remain painted");
  check(
    ink.ringLayerOpacity > 0 && ink.ringLayerOpacity <= 0.5,
    "cipher layer stays faint rather than opaque",
  );
  if (!ink.contrast) return;
  check(
    ink.contrast.samples > 100,
    "composite contrast samples the empty upper dial arc",
  );
  check(
    ink.contrast.p99 <= 1.6 && ink.contrast.maximum <= 2.2,
    `upper dial arc stays subordinate (99th percentile ${ink.contrast.p99?.toFixed(3)}, maximum ${ink.contrast.maximum?.toFixed(3)})`,
  );
}
