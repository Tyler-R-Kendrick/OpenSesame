import fs from "node:fs";
import path from "node:path";

/**
 * The bottom chrome has to clear the home indicator, and headless Chromium
 * reports every safe-area inset as zero — so the insets are asserted in the
 * stylesheet rather than in the layout. Reading the built CSS keeps the claim
 * honest: it is the shipped file, not the source we hoped got shipped.
 */
export function checkSafeAreas({ dist, harness }) {
  const assets = path.join(dist, "assets");
  const css = fs
    .readdirSync(assets)
    .filter((file) => file.endsWith(".css"))
    .map((file) => fs.readFileSync(path.join(assets, file), "utf8"))
    .join("\n");
  for (const [what, pattern] of [
    [
      "the drawer clears the home indicator",
      /\.drawer\{[^}]*safe-area-inset-bottom/,
    ],
    ["the top bar clears the notch", /\.topbar\{[^}]*safe-area-inset-top/],
    ["side gutters clear a landscape notch", /safe-area-inset-left/],
  ]) {
    harness.check(
      pattern.test(css.replace(/\s+/g, "")) || pattern.test(css),
      what,
    );
  }
}
