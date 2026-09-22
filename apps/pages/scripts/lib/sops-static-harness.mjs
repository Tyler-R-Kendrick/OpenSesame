/**
 * The harness behind `verify-sops-static.mjs`.
 *
 * `dist/` is served by a plain static file server with no API routes and
 * no privileged headers — the deployment a static host gives you. A browser
 * context aborts and records every request to any other origin, so a Host
 * call, a native delegation, a loopback agent or a CDN fetch is a failure
 * rather than something that quietly works.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** A plain static host: real files, SPA fallback, nothing else. */
export function createStaticServer({ dist, base, record }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rel = url.pathname.startsWith(base)
      ? url.pathname.slice(base.length)
      : url.pathname.slice(1);
    const file = path.join(dist, rel);
    if (rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(fs.readFileSync(file));
      return;
    }
    if (rel && /\.[a-z0-9]+$/i.test(rel)) {
      record("MISSING-ASSET", url.pathname);
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(rel ? 404 : 200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(dist, "index.html")));
  });
}

export function launchBrowser() {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    headless: true,
  });
}

/** A context that serves only `origin` and records every other request. */
export async function newContext(browser, { origin, record }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    // Anything else — a Host, a daemon, a CDN, a conversion service.
    record("EXTERNAL-REQUEST", `${request.method()} ${request.url()}`);
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    record("PAGE-ERROR", String(error?.message ?? error).slice(0, 400)),
  );
  page.on("console", (message) => {
    if (message.type() === "error") {
      record("CONSOLE-ERROR", message.text().slice(0, 400));
    }
  });
  return { context, page };
}

export async function enterAsGuest(page) {
  await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .click();
  await page.waitForTimeout(2000);
}

/** In-app navigation: a reload would drop the guest session. */
export async function gotoSecurity(page) {
  const rail = page.getByRole("link", { name: /^settings\// }).first();
  if (await rail.count()) await rail.click();
  else await page.getByText("settings/", { exact: true }).first().click();
  await page.waitForTimeout(1200);
  const security = page.getByRole("link", { name: /security/i }).first();
  if (await security.count()) await security.click();
  await page.waitForTimeout(1200);
}

export async function openSheet(page) {
  await page.getByRole("button", { name: "SOPS document" }).click();
  await page.waitForTimeout(500);
  return page.getByRole("dialog", { name: "SOPS document" });
}

export async function chooseFile(page, name, body) {
  await page.getByLabel("Choose a SOPS YAML or JSON file").setInputFiles({
    name,
    mimeType: "text/yaml",
    buffer: Buffer.from(body, "utf8"),
  });
  await page.waitForTimeout(700);
}

/** Open an upstream-encrypted file, edit it, and save ciphertext. */
export async function documentJourney(page, label, context) {
  const { cipher, expected, identity, recipient, check, record, out } = context;
  const sheet = await openSheet(page);
  await chooseFile(page, "basic-yaml.enc.yaml", cipher);
  const beforeOpen = await page.evaluate(() => document.body.innerText);
  check(
    !beforeOpen.includes("world"),
    `${label}: inspection reveals no plaintext`,
  );
  check(
    beforeOpen.includes(recipient),
    `${label}: the untrusted recipient is shown before unlock`,
  );

  await sheet.getByLabel("age identity").fill(identity);
  await sheet.getByRole("button", { name: "Open" }).click();
  const editor = sheet.getByLabel("Decrypted document");
  try {
    await editor.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    record("SHEET", (await sheet.innerText()).slice(0, 800));
    check(false, `${label}: the document never opened`);
    return "";
  }
  // Upstream's YAML emitter indents four spaces and this engine indents two;
  // the conformance suite compares parsed trees, so here the check is every
  // line, in order, with indentation normalized away.
  const lines = (text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  const got = await editor.inputValue();
  check(
    JSON.stringify(lines(got)) === JSON.stringify(lines(expected)),
    `${label}: decrypted upstream's file to the same content, in the same order`,
  );
  check(
    !got.includes("ENC[AES256_GCM,"),
    `${label}: nothing encrypted remains in the plaintext`,
  );

  await editor.fill(
    got.replace("hello: world", "hello: edited in the browser"),
  );
  let saved = "";
  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      sheet.getByRole("button", { name: "Save encrypted copy" }).click(),
    ]);
    saved = fs.readFileSync(await download.path(), "utf8");
  } catch {
    record("SHEET", (await sheet.innerText()).slice(0, 800));
    check(false, `${label}: no encrypted copy was offered`);
    return "";
  }
  check(
    saved.includes("ENC[AES256_GCM,"),
    `${label}: the saved copy is SOPS ciphertext`,
  );
  check(
    !saved.includes("edited in the browser"),
    `${label}: the saved copy holds no plaintext`,
  );
  check(
    saved.includes(recipient),
    `${label}: the saved copy keeps its recipient`,
  );
  fs.writeFileSync(path.join(out, `${label}-saved.sops.yaml`), saved);
  await page.screenshot({ path: path.join(out, `${label}-open.png`) });
  return saved;
}

/** A person with no account encrypts new content to a typed recipient. */
export async function newDocumentJourney(page, label, context) {
  const { recipient, check, record, out } = context;
  const sheet = page.getByRole("dialog", { name: "SOPS document" });
  await chooseFile(page, "plain.yaml", "hello: fresh document\ncount: 7\n");
  await sheet.getByLabel("Recipients").fill(recipient);
  let saved = "";
  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      sheet.getByRole("button", { name: "Encrypt" }).click(),
    ]);
    saved = fs.readFileSync(await download.path(), "utf8");
  } catch {
    record("SHEET", (await sheet.innerText()).slice(0, 800));
    check(false, `${label}: no new encrypted document was offered`);
    return "";
  }
  check(
    saved.includes("ENC[AES256_GCM,"),
    `${label}: a new document encrypts to SOPS ciphertext`,
  );
  check(
    !saved.includes("fresh document"),
    `${label}: the new document holds no plaintext`,
  );
  fs.writeFileSync(path.join(out, `${label}-new.sops.yaml`), saved);
  return saved;
}

/** The shipped bundle must name no native runtime (SB-071). */
export function scanBundle(dist) {
  const banned =
    /OPENSESAME_SOPS_BIN|child_process|node:fs|\/dev\/stdin|opensesame pass protect/;
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (
        /\.(js|mjs|css|html)$/.test(name) &&
        banned.test(fs.readFileSync(full, "utf8"))
      ) {
        offenders.push(path.relative(dist, full));
      }
    }
  };
  walk(dist);
  return offenders;
}
