import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import {
  nativeEnableConnections,
  nativeVisit,
} from "./lib/native-browser-catalog-journey.mjs";
import { nativeExpectedFailures } from "./lib/native-browser-expected-failures.mjs";
import { routeNativeOriginAuthority } from "./lib/native-browser-origin-authority.mjs";
import {
  approveNativePublicConsent,
  noNativeSecrets,
} from "./lib/native-browser-public-journey.mjs";
import { sealWithPin, unlockWithPin } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.EVIDENCE_DIST ?? path.resolve(here, "..", "dist");
const origin = "https://self-host.example.org";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const callback = `${origin}${base}auth/native-connector.html`;
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ?? "/tmp/origin-app-proof",
);
fs.mkdirSync(out, { recursive: true });
const harness = createHarness({ dist, origin, base, out });
const browser = await harness.launch();
const results = [];
const expectedFailures = [];
let page;
let authority;
try {
  ({ page } = await harness.newPage(browser, {
    device: { viewport: { width: 1366, height: 1000 } },
  }));
  authority = await routeNativeOriginAuthority(
    page.context(),
    harness,
    callback,
  );
  expectedFailures.push(nativeExpectedFailures(harness, page, authority));
  await page.goto(`${origin}${base}`);
  await sealWithPin(page);
  await nativeEnableConnections(page, base);
  await nativeVisit(page, base, "connections/origin");
  await page
    .getByRole("heading", { name: "Cursor Origin", exact: true })
    .waitFor();
  await page.getByLabel("Origin app ID", { exact: true }).fill(authority.appId);
  await page
    .getByLabel("Origin Ed25519 PKCS#8 private key", {
      exact: true,
      selector: 'input[type="password"]',
    })
    .fill(authority.privateKey);
  harness.check(
    (await page.getByLabel("OAuth client secret", { exact: true }).count()) ===
      0,
    "Origin form never offers an OAuth client secret",
  );
  const unverified = page.getByRole("img", {
    name: /^Cursor Origin (?:access verified|connected)(?:\.|$)/,
    exact: true,
  });
  harness.check(
    (await unverified.count()) === 0,
    "Origin form rendering alone is not a verified connection",
  );
  await page.screenshot({
    path: path.join(out, "origin-configure.png"),
    fullPage: false,
    animations: "disabled",
  });
  await approveNativePublicConsent(
    page,
    callback,
    page.getByRole("button", {
      name: "Sign in to Cursor Origin",
      exact: true,
    }),
  );
  const mark = page.getByRole("img", {
    name: /^Cursor Origin (?:access verified|connected)(?:\.|$)/,
    exact: true,
  });
  await mark.waitFor({ timeout: 30_000 });
  harness.check(
    authority.state.minted === 1 &&
      authority.state.appProofs.length === 1 &&
      authority.state.calls.some(
        (call) => call.url === "https://api.cursor.com/v1/origin/rate_limit",
      ),
    "Origin receipt, exact app-JWT mint and rate-limit read complete before connected status",
  );
  await noNativeSecrets(page, authority.secrets, harness.check);
  const callsBeforeReload = authority.state.calls.length;
  authority.state.expectedDocuments.add(page.url());
  await page.reload();
  await unlockWithPin(page);
  await mark.waitFor({ timeout: 30_000 });
  harness.check(
    authority.state.calls.length === callsBeforeReload,
    "encrypted cold reload restores the verified installation without replaying provider calls",
  );
  results.push("configuration", "receipt", "mint", "rate-limit", "cold-reload");
  await expect
    .poll(() => Date.now(), { timeout: 90_000 })
    .toBeGreaterThan(authority.state.latestExpiry);
  let remintPopups = 0;
  page.on("popup", () => remintPopups++);
  await page
    .getByRole("button", { name: "Verify Cursor Origin access", exact: true })
    .click();
  await expect.poll(() => authority.state.minted).toBe(2);
  await mark.waitFor({ timeout: 30_000 });
  harness.check(
    authority.state.installUrls.length === 1 && remintPopups === 0,
    "expired installation token remints without another installation popup",
  );
  results.push("expiry-remint");
  await expect(
    page.getByRole("button", {
      name: "Verify Cursor Origin access",
      exact: true,
    }),
  ).toBeEnabled();
  harness.check(
    authority.state.calls.filter(
      (call) => call.url === "https://api.cursor.com/v1/origin/rate_limit",
    ).length === 2,
    "expiry remint proves the new installation token with a second rate-limit read",
  );
  await noNativeSecrets(page, authority.secrets, harness.check);
  const plaintext = await page.evaluate(() =>
    JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }),
  );
  for (const secret of authority.secrets)
    harness.check(
      !plaintext.includes(secret),
      "Origin private keys, receipts, app JWTs and installation tokens never appear in plaintext Web Storage",
    );
  await mark.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(out, "origin-verified.png"),
    fullPage: false,
    animations: "disabled",
  });
  results.push("post-remint-rate-limit", "no-secret-rendering");
} catch (error) {
  harness.failures.push(`[${harness.step()}] ${String(error)}`);
  if (page && !page.isClosed()) {
    const notifications = page
      .getByRole("button", { name: /^Notifications/ })
      .first();
    if (await notifications.count())
      await notifications.click().catch(() => undefined);
    fs.writeFileSync(
      path.join(out, "failure.txt"),
      `${page.url()}\n${await page.locator("body").innerText()}`,
    );
    await page
      .screenshot({ path: path.join(out, "failure.png"), fullPage: false })
      .catch(() => undefined);
  }
} finally {
  await browser.close();
}
const hard = harness.log.filter(
  (entry) =>
    [
      "LOOPBACK-REQUEST",
      "HTTP-ERROR",
      "console-error",
      "PAGE-ERROR",
      "MISSING-ASSET",
      "external-request",
    ].includes(entry.kind) &&
    expectedFailures.every((unexpected) => unexpected(entry)),
);
const provenance = {
  dist,
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  indexSha256: createHash("sha256")
    .update(fs.readFileSync(path.join(dist, "index.html")))
    .digest("hex"),
};
fs.writeFileSync(
  path.join(out, "receipt.json"),
  `${JSON.stringify({ authority: "synthetic documented Origin protocol authority; no live account or credentials", provenance, results, protocol: { calls: authority?.state.calls ?? [], appProofs: authority?.state.appProofs ?? [] }, failures: harness.failures, hard, checks: harness.log.filter((entry) => ["PASS", "FAIL"].includes(entry.kind)) }, null, 2)}\n`,
);
if (harness.failures.length || hard.length) {
  console.error(JSON.stringify({ failures: harness.failures, hard }, null, 2));
  process.exitCode = 1;
} else {
  console.log(`ALL ORIGIN APP CHECKS PASSED — ${results.join(", ")}`);
}
