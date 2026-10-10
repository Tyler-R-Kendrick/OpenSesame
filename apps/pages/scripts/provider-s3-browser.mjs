/** Production browser -> real MinIO, without a relay or fabricated provider responses. */
import assert from "node:assert/strict";
import { X509Certificate, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startProviderS3 } from "../../../scripts/test/provider-s3-service.mjs";
import { phoneContext } from "./lib/mobile-contract.mjs";
import {
  nativeEnableConnections,
  nativeVisit,
} from "./lib/native-browser-catalog-journey.mjs";
import { sealWithPin, unlockWithPin } from "./lib/pages-journey.mjs";
import { startProviderAuthOrigin } from "./provider-auth-origin.mjs";
import "./lib/expect-timeout.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const dist = path.resolve(process.env.PROVIDER_S3_DIST);
const tls = path.resolve(process.env.PROVIDER_S3_SITE_TLS);
const out = path.resolve(process.env.PROVIDER_S3_OUT);
const profile = JSON.parse(
  fs.readFileSync(path.join(dist, "security-profile.json"), "utf8"),
);
assert.equal(profile.profile, "dedicated_origin");
assert.equal(profile.headerSecurity, true);
const origin = new URL(profile.canonicalOrigin);
const base = "/OpenSesame/";
const cert = new X509Certificate(
  fs.readFileSync(path.join(tls, "vault-cert.pem")),
);
const spki = createHash("sha256")
  .update(cert.publicKey.export({ type: "spki", format: "der" }))
  .digest("base64");
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const service = await startProviderS3({ root, out, origin: origin.origin });
let browser;
let site;
try {
  site = await startProviderAuthOrigin({
    dist,
    tls,
    base,
    hostname: origin.hostname,
    port: Number(origin.port),
  });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM,
    headless: true,
    env: {
      ...process.env,
      NO_PROXY: [process.env.NO_PROXY, origin.hostname, "127.0.0.1"]
        .filter(Boolean)
        .join(","),
      no_proxy: [process.env.no_proxy, origin.hostname, "127.0.0.1"]
        .filter(Boolean)
        .join(","),
    },
    args: [
      "--no-sandbox",
      `--host-resolver-rules=MAP ${origin.hostname} 127.0.0.1`,
      `--proxy-bypass-list=${origin.hostname};127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${spki},${service.spki}`,
    ],
  });
  const receipts = [];
  for (const [label, device] of [
    ["desktop", { viewport: { width: 1366, height: 1000 } }],
    ["phone", phoneContext({ width: 390, height: 844 })],
  ])
    receipts.push(await journey(browser, device, label));
  fs.writeFileSync(
    path.join(out, "receipt.json"),
    JSON.stringify(
      {
        provider: service.version,
        packageSha256: service.packageSha256,
        origin: origin.origin,
        noRelay: true,
        headers: "COOP same-origin; COEP require-corp",
        receipts,
      },
      null,
      2,
    ),
  );
  console.log(
    "provider S3: real MinIO browser verification/read/reload/remove passed on desktop and phone",
  );
} finally {
  await browser?.close();
  await site?.close();
  await service.close();
}

async function fillBucket(page) {
  await page
    .getByLabel("S3 HTTPS service origin", { exact: true })
    .fill(service.endpoint);
  await page.getByLabel("Bucket", { exact: true }).fill(service.bucket);
  await page
    .getByLabel("Access key ID", { exact: true })
    .fill(service.accessKey);
}

async function reloadUnlocked(page) {
  await page.reload();
  await unlockWithPin(page);
}

async function refuseIncorrectSecret(page) {
  await page
    .getByLabel("Secret access key", { exact: true })
    .fill("incorrect-signing-secret");
  await page.getByRole("button", { name: /Verify and connect S3/ }).click();
  await page
    .getByRole("img", { name: /Provider permissions do not allow/ })
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("region", { name: /S3.*connection status/ }).count(),
    0,
  );
}

async function saveS3Failure(page, label) {
  const messages = await page
    .getByRole("region", { name: /S3.*connection status/ })
    .getByRole("img")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label")),
    );
  const text =
    `${await page.locator("main").innerText()}\nStatus labels: ${JSON.stringify(messages)}`
      .replaceAll(service.secretKey, "[redacted secret]")
      .replaceAll(service.accessKey, "[redacted access key]");
  fs.writeFileSync(path.join(out, `${label}-failure.txt`), text, {
    mode: 0o600,
  });
  await page.screenshot({
    path: path.join(out, `${label}-failure.png`),
    timeout: 5000,
  });
}

async function reloadAndRemoveBucket(page) {
  await reloadUnlocked(page);
  await nativeVisit(page, base, "connections/s3");
  await page
    .getByRole("img", { name: /S3.*access verified/ })
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Remove connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm remove connector", exact: true })
    .click();
  await page
    .getByRole("region", { name: /S3.*connection status/ })
    .waitFor({ state: "detached" });
  await nativeVisit(page, base, "connections#connected");
  await page
    .getByRole("heading", { name: "Nothing connected", exact: true })
    .waitFor();
  await reloadUnlocked(page);
  await nativeVisit(page, base, "connections/s3");
  await page.getByRole("button", { name: /Verify and connect S3/ }).waitFor();
  assert.equal(
    await page.getByRole("region", { name: /S3.*connection status/ }).count(),
    0,
    "Removed S3 credentials remain absent after cold reload",
  );
}

async function journey(browser, device, label) {
  const context = await browser.newContext({
    ...device,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const responses = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().startsWith(service.endpoint))
      responses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  try {
    await page.goto(`${site.origin}${base}`);
    await sealWithPin(page);
    await nativeEnableConnections(page, base);
    await nativeVisit(page, base, "connections/s3");
    await fillBucket(page);
    const secret = () => page.getByLabel("Secret access key", { exact: true });
    const connect = () =>
      page.getByRole("button", { name: /Verify and connect S3/ });
    await refuseIncorrectSecret(page);
    await secret().fill(service.secretKey);
    await connect().click();
    await page
      .getByRole("img", { name: /S3.*access verified/ })
      .first()
      .waitFor();
    assert.equal(await secret().inputValue(), "");
    await page.getByText("List object keys", { exact: true }).first().click();
    await page
      .getByRole("button", { name: "List object keys", exact: true })
      .click();
    await page.getByText("fixture/sealed-document", { exact: true }).waitFor();
    assert.equal(
      (await page.locator("main").innerText()).includes(service.secretKey),
      false,
    );
    await page.screenshot({ path: path.join(out, `${label}-s3-verified.png`) });
    await reloadAndRemoveBucket(page);
    assert.ok(
      responses.some((response) => response.status === 403),
      "Real MinIO refused incorrect signing key",
    );
    assert.ok(
      responses.some((response) => response.status === 200),
      "Real MinIO verified signed bucket access",
    );
    assert.deepEqual(errors, []);
    return {
      label,
      incorrectCredentialRefused: true,
      actualBucketVerified: true,
      objectRead: true,
      coldReload: true,
      removal: true,
      responses,
    };
  } catch (error) {
    await saveS3Failure(page, label);
    throw error;
  } finally {
    await context.close();
  }
}
