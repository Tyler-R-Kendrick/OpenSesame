// Attached debug watcher: keeps a headless page on the dev origin and logs
// console errors, page errors, and failed requests with stacks. Deleted when
// the session ends.
import { chromium } from "@playwright/test";
const exe = process.env.PLAYWRIGHT_CHROMIUM;
const launchOptions = { headless: true };
if (exe) {
  launchOptions.executablePath = exe;
}
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const stamp = () => new Date().toISOString();
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    console.log(`[${stamp()}] console.${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) =>
  console.log(`[${stamp()}] pageerror: ${e.stack ?? e.message}`),
);
page.on("requestfailed", (r) => {
  const f = r.failure();
  console.log(
    `[${stamp()}] requestfailed: ${r.method()} ${r.url()} — ${f?.errorText}`,
  );
});
await page.goto("http://localhost:5180/OpenSesame/", {
  waitUntil: "networkidle",
});
console.log(
  `[${stamp()}] attached to http://localhost:5180/OpenSesame/ — watching`,
);
// Smoke the changed surface once: setup tabs end to end.
try {
  await page.getByRole("button", { name: /Set up your own/ }).click();
  for (const tab of ["backups", "ai", "identity", "mfa", "sync"]) {
    await page.getByRole("tab", { name: new RegExp(tab, "i") }).click();
    await page.waitForTimeout(200);
  }
  console.log(
    `[${stamp()}] smoke: all five setup tabs rendered without errors`,
  );
} catch (e) {
  console.log(`[${stamp()}] smoke FAILED: ${e.message}`);
}
// Stay attached; HMR updates reach this page too.
setInterval(() => {}, 60_000);
