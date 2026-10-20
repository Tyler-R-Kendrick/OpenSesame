/** Compose ten whole-screen before/after sheets from the real gate journey. */
import { chromium } from "@playwright/test";
import { composeLockscreenGallery } from "./lib/lockscreen-parity-gallery.mjs";
const [raw, output] = process.argv.slice(2);
if (!raw || !output)
  throw new Error(
    "usage: capture-lockscreen-parity-gallery.mjs <raw captures> <gallery output>",
  );
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  headless: true,
});
try {
  await composeLockscreenGallery(browser, raw, output);
} finally {
  await browser.close();
}
