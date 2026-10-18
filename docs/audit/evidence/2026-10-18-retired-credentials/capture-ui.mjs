import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { sealWithPin, PIN } = await import(
  pathToFileURL(join(repo, "apps/pages/scripts/lib/pages-journey.mjs")).href
);
const require = createRequire(join(repo, "package.json"));
const { chromium } = require("@playwright/test");
const [dist, label, output] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const base = "/OpenSesame/";
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (!path.startsWith(base) || path.includes("..")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const relative = path.slice(base.length);
    let data;
    try {
      data = await readFile(join(dist, relative || "index.html"));
    } catch {
      if (extname(relative)) throw new Error("missing asset");
      data = await readFile(join(dist, "index.html"));
    }
    res.setHeader("Content-Type", mime[extname(relative)] ?? "text/html");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
});
const report = {
  label,
  dist,
  browser: browser.version(),
  profiles: [],
  qualification:
    "Actual production Vite build and real PIN setup/native browser storage. Phone is viewport emulation; service workers blocked and external networking denied. No ownership/authentication or storage doubles.",
};
async function screenshot(page, name) {
  const file = join(output, `${label}-${name}.png`);
  await page.screenshot({ path: file });
  const data = await readFile(file);
  return { file, sha256: createHash("sha256").update(data).digest("hex") };
}
try {
  for (const profile of [
    { name: "desktop", width: 1280, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      hasTouch: profile.name === "phone",
      isMobile: profile.name === "phone",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(origin + base, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await page.evaluate((href) => {
      history.pushState(null, "", href);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `${base}settings/security`);
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    await page.waitForTimeout(600);
    const count = await page.locator("#retired-passwords").count();
    // Both builds scroll the same Security canvas to its end.
    await page.locator(".section").evaluateAll((nodes) => {
      for (const node of nodes) node.scrollTop = node.scrollHeight;
    });
    const images = [await screenshot(page, `${profile.name}-security`)];
    const measured = await page
      .locator("#retired-passwords")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const b = node.getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        }),
      );
    if (label === "after") {
      if (count !== 1)
        throw new Error("Missing actual retired management panel");
      await page
        .getByRole("button", { name: "Manage retired passwords", exact: true })
        .click();
      await page.getByLabel("Current PIN", { exact: true }).waitFor();
      images.push(await screenshot(page, `${profile.name}-fresh-primary`));
      await page.getByLabel("Current PIN", { exact: true }).fill(PIN);
      await page
        .getByRole("button", { name: "Verify current key", exact: true })
        .click();
      await page
        .getByLabel("Retired password", { exact: true })
        .waitFor({ timeout: 60000 });
      images.push(await screenshot(page, `${profile.name}-management`));
      await page
        .getByLabel("Retired password", { exact: true })
        .fill("controlled evidence formerly used password");
      await page
        .getByLabel("Open a synthetic vault when this password is used", {
          exact: true,
        })
        .check();
      const add = page.getByRole("button", {
        name: "Add retired password",
        exact: true,
      });
      if (await add.isEnabled()) throw new Error("Synthetic consent bypass");
      images.push(await screenshot(page, `${profile.name}-synthetic-consent`));
      await page.getByLabel(/I understand this creates fictional/).check();
      await add.click();
      await page.getByLabel("Current PIN", { exact: true }).fill(PIN);
      await page
        .getByRole("button", { name: "Verify current key", exact: true })
        .click();
      await page
        .getByText("Synthetic vault", { exact: false })
        .first()
        .waitFor({ timeout: 60000 });
      images.push(await screenshot(page, `${profile.name}-enrolled`));
      await page
        .getByRole("dialog", { name: "Retired passwords", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Manage agent canaries", exact: true })
        .click();
      await page.getByLabel("Receiver endpoint", { exact: true }).waitFor();
      images.push(await screenshot(page, `${profile.name}-canary-receiver`));
    }
    report.profiles.push({
      ...profile,
      retiredPanels: count,
      measured,
      images,
      errors,
    });
    if (errors.length)
      throw new Error("Browser errors during production journey");
    await writeFile(
      join(output, `${label}-report.json`),
      JSON.stringify(report, null, 2),
    );
    await context.close();
  }
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  await writeFile(
    join(output, `${label}-report.json`),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
