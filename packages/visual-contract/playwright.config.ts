import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const PORT = 5180;
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

/**
 * apps/pages is built for GitHub Pages by default (`base: "/OpenSesame/"` in
 * apps/pages/vite.config.ts), which means `vite preview` serves the app only
 * under that path prefix and a request to "/" 404s. Playwright's baseURL
 * joining treats a leading "/" in page.goto() as an absolute path against the
 * origin (it does NOT respect a non-root baseURL path segment), so the whole
 * suite is far simpler if the app is served at "/" instead. VITE_BASE
 * overrides that default for both the build and the preview server started
 * below — this env var is apps/pages' own escape hatch, not something new we
 * invented here.
 */
const PREVIEW_ENV = { VITE_BASE: "/" };

/**
 * Root already pins @playwright/test to 1.55.1 (matched by this package's
 * own devDependency) with a preinstalled Chromium at PLAYWRIGHT_BROWSERS_PATH
 * (see env below). When versions match, Playwright's default browser
 * resolution already finds it via PLAYWRIGHT_BROWSERS_PATH, so this
 * executablePath override only kicks in as a defensive fallback (e.g. a
 * version drift, or a runtime where PLAYWRIGHT_BROWSERS_PATH isn't set) and
 * is a no-op otherwise.
 */
const PINNED_CHROMIUM = "/opt/pw-browsers/chromium";

/**
 * Chromium's own process sandbox refuses to start when the launching process
 * is root ("Running as root without --no-sandbox is not supported",
 * https://crbug.com/638180) — common for containerized CI/agent runners.
 * `--no-sandbox` is scoped to exactly that case (checked via getuid, not an
 * env var guess) so a normal, non-root developer machine keeps Chromium's
 * full process sandbox by default.
 */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const launchOptions = {
  ...(existsSync(PINNED_CHROMIUM) ? { executablePath: PINNED_CHROMIUM } : {}),
  ...(isRoot ? { args: ["--no-sandbox"] } : {}),
};

export default defineConfig({
  testDir: "./tests",
  outputDir: "./output/test-results",
  timeout: 60_000,
  // Multiple concurrent Chromium workers can exhaust memory/fds in a
  // constrained container, surfacing as spurious "browser has been closed"
  // failures unrelated to the app under test. This suite is a manually-run
  // visual check, not a tight CI loop, so serial execution is the safer
  // default; a real developer machine will still finish this in ~1 minute.
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    launchOptions,
    trace: "retain-on-failure",
    screenshot: "off",
  },
  webServer: {
    command:
      "pnpm --filter @opensesame/pages build && pnpm --filter @opensesame/pages preview",
    // Playwright 1.55.1 rejects a webServer config specifying both `port`
    // and `url` ("Either 'port' or 'url' should be specified"); `url` alone
    // both pins the readiness check and matches `use.baseURL` above, so it's
    // the only one needed.
    url: BASE_URL,
    env: PREVIEW_ENV,
    // No CI env var is set in this repo by policy, so reuseExistingServer is
    // effectively always true here — kept as a sane default regardless.
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        // Matches the actual .impeccable/screenshots/*-desktop.png baseline
        // dimensions (verified via their PNG IHDR chunks), not an assumed
        // 1280x800 — a mismatch here fails every desktop shot on size alone,
        // independent of any real visual regression.
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        // devices["iPhone 13"] sets defaultBrowserType: "webkit" to emulate
        // real Mobile Safari — but only Chromium is preinstalled in this
        // repo's environments (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, see
        // launchOptions above). Keep the device's UA/viewport/touch
        // properties for realistic mobile emulation, but force Chromium as
        // the actual engine so this works everywhere Chromium does.
        defaultBrowserType: "chromium",
        viewport: { width: 390, height: 844 },
        // The checked-in *-mobile.png baselines are exactly 390x844 (verified
        // via their PNG IHDR chunks, same as the desktop 1440x900 fix above).
        // devices["iPhone 13"]'s deviceScaleFactor: 3 would triple that to
        // 1170x2532, failing every mobile shot on a dimension mismatch alone.
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
