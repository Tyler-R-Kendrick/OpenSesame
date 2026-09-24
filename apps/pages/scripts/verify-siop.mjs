// Prove native SIOPv2 consent, passkey gating, and fragment redirects against
// the built Pages bundle on the production origin with no backend (ADR 0116).
//
//   VITE_BASE=/OpenSesame/ pnpm --filter @opensesame/pages build
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:siop
//
// Fails on page errors, console errors, loopback requests, or a token that
// does not verify through @opensesame/siop-v2 verifySelfIssuedIdToken.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { build } from "vite";
import { chooseCapabilities } from "./lib/choose-capabilities.mjs";
import {
  SIOP_RP,
  approveSiopConsent,
  buildSiopUrl,
  denySiopConsent,
  installWebAuthn,
  siopIssuer,
} from "./lib/siop-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
const out = process.env.PAGES_VERIFY_OUT ?? "/tmp/opensesame-siop";
const VAULT_PASSWORD = "Cedar-lantern-47-river!";

if (!fs.existsSync(`${dist}/index.html`)) {
  console.error(`no build at ${dist} — run the pages build first`);
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

async function bundleVerify() {
  const result = await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    define: {
      "process.env.NODE_DEBUG_NATIVE": "false",
      "process.env.NODE_ENV": '"production"',
    },
    resolve: {
      alias: {
        "@opensesame/os-domain": `${root}/packages/os-domain/src/browser.ts`,
      },
    },
    build: {
      write: false,
      target: "es2022",
      lib: {
        entry: fileURLToPath(
          new URL("./fixtures/siop-verify.ts", import.meta.url),
        ),
        name: "SiopVerify",
        formats: ["es"],
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const chunk = output.find((file) => file.type === "chunk");
  if (!chunk) throw new Error("SIOP verify bundle missing");
  const modPath = `${out}/siop-verify.mjs`;
  fs.writeFileSync(modPath, chunk.code);
  return import(`${modPath}?v=${Date.now()}`);
}

async function bundleFixture() {
  const result = await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    define: {
      "process.env.NODE_DEBUG_NATIVE": "false",
      "process.env.NODE_ENV": '"production"',
    },
    resolve: {
      alias: {
        "@opensesame/os-domain": `${root}/packages/os-domain/src/browser.ts`,
      },
    },
    build: {
      write: false,
      target: "es2022",
      lib: {
        entry: fileURLToPath(
          new URL("./fixtures/siop-iam.ts", import.meta.url),
        ),
        name: "SiopIamFixture",
        formats: ["iife"],
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  return output
    .filter((file) => file.type === "chunk")
    .map((file) => file.code)
    .join("\n");
}

async function seedSiopFixture(context, fixtureScript) {
  await context.route(`${origin}/fixture`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Disposable SIOP fixture</body></html>",
    }),
  );
  const seedPage = await context.newPage();
  await seedPage.goto(`${origin}/fixture`);
  const seedDevice = await installWebAuthn(seedPage);
  await seedPage.addScriptTag({ content: fixtureScript });
  if (!(await seedPage.evaluate(() => Boolean(globalThis.SiopIamFixture))))
    throw new Error("SIOP IAM fixture did not load");
  const identities = await seedPage.evaluate(() => SiopIamFixture.seed());
  const { credentials } = await seedDevice.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: seedDevice.authenticatorId,
  });
  await seedPage.close();
  return { identities, credentials };
}

async function unlockVault(page) {
  const password = page.getByLabel("Password", { exact: true });
  await expect(password).toBeVisible();
  await password.fill(VAULT_PASSWORD);
  await password.press("Enter");
  await expect(password).not.toBeVisible();
}

async function gotoUnlocked(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  const password = page.getByLabel("Password", { exact: true });
  const unlocked = page.getByRole("heading", {
    name: /Self-issued sign-in to|Invalid Self-Issued|Vaults|Vault /,
  });
  // Full navigations drop in-memory vault keys; wait for unlock chrome or the
  // destination rather than racing isVisible() on a still-hydrating form.
  await Promise.race([
    password.waitFor({ state: "visible", timeout: 30_000 }),
    unlocked.waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  if (await password.isVisible()) await unlockVault(page);
}

async function installPasskeyCredentials(page, credentials) {
  const device = await installWebAuthn(page);
  for (const credential of credentials) {
    await device.cdp.send("WebAuthn.addCredential", {
      authenticatorId: device.authenticatorId,
      credential,
    });
  }
  return device;
}

const siopVerify = await bundleVerify();
const siopFixture = await bundleFixture();
const harness = createHarness({ dist, origin, base, out });
const browser = await harness.launch();

function routeRp(context) {
  return context.route(`${SIOP_RP}/**`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<!doctype html><html><body>SIOP RP callback</body></html>",
    }),
  );
}

async function runAllow(page, clientId, personName, label) {
  const nonce = `nonce-${label}-${crypto.randomUUID().slice(0, 8)}`;
  const state = `state-${label}`;
  const siopUrl = buildSiopUrl(origin, base, clientId, { nonce, state });
  await gotoUnlocked(page, siopUrl);
  const redirectUrl = await approveSiopConsent(page, personName);
  expect(redirectUrl).not.toMatch(/"d"\s*:/);
  expect(redirectUrl).not.toContain("privateJwk");
  const verified = await siopVerify.verifySiopRedirect(redirectUrl, {
    issuer: siopIssuer(origin, base),
    clientId,
    nonce,
  });
  expect(verified.aud).toBe(clientId);
  expect(JSON.stringify(verified)).not.toMatch(/"d"\s*:/);
  return verified.sub;
}

try {
  const { page, context } = await harness.newPage(browser);
  await routeRp(context);
  const { identities, credentials } = await seedSiopFixture(
    context,
    siopFixture,
  );
  await installPasskeyCredentials(page, credentials);
  // `/siop` and the local applications this seeds belong to Self-issued
  // OpenID and browser-local IAM, which are always on (ADR 0139): the walk
  // asks for them and `chooseCapabilities` finds nothing to switch.
  await chooseCapabilities(
    context,
    1280,
    ["Self-issued OpenID"],
    `${origin}${base}`.replace(/\/$/, ""),
  );
  await gotoUnlocked(page, `${origin}${base}`);
  const { appOneId, appTwoId, personName } = identities;

  const subOne = await runAllow(page, appOneId, personName, "primary");
  console.log(
    "PASS allow: verified Self-Issued ID Token for primary application",
  );

  await gotoUnlocked(page, `${origin}${base}vault`);
  const subTwo = await runAllow(page, appTwoId, personName, "pairwise");
  expect(subTwo).not.toBe(subOne);
  console.log("PASS pairwise: second application yields a distinct subject");

  const denyNonce = "nonce-deny-0S6_WzA2Mj";
  const denyUrl = buildSiopUrl(origin, base, appOneId, {
    nonce: denyNonce,
    state: "deny-state",
  });
  await gotoUnlocked(page, denyUrl);
  const deniedUrl = await denySiopConsent(page);
  const denied = siopVerify.parseSiopDenyRedirect(deniedUrl);
  expect(denied.error).toBe("access_denied");
  console.log("PASS deny: access_denied returned to the relying party");

  const replayNonce = "nonce-replay-0S6_WzA2Mj";
  const replayUrl = buildSiopUrl(origin, base, appOneId, {
    nonce: replayNonce,
    state: "replay-state",
  });
  await gotoUnlocked(page, replayUrl);
  await approveSiopConsent(page, personName);

  await gotoUnlocked(page, `${origin}${base}vault`);
  const lock = page
    .getByRole("button", { name: "Lock vault", exact: true })
    .filter({ visible: true });
  await lock.click();
  await expect(
    page.getByRole("button", { name: "Continue as guest", exact: true }),
  ).toBeVisible();
  await page.goto(replayUrl, { waitUntil: "networkidle" });
  await expect(page).not.toHaveURL(new RegExp(`^${SIOP_RP}/`));
  await expect(
    page.getByRole("button", { name: "Continue as guest", exact: true }),
  ).toBeVisible();
  console.log(
    "PASS lock fail-closed: locked vault refuses the SIOP ceremony without a callback",
  );

  await context.close();
} catch (error) {
  for (const ctx of browser.contexts()) {
    for (const tab of ctx.pages()) {
      await tab
        .screenshot({ path: `${out}/failure-${Date.now()}.png` })
        .catch(() => undefined);
    }
  }
  throw error;
} finally {
  await browser.close();
}

if (
  harness.log.some(
    (row) => row.kind === "PAGE-ERROR" || row.kind === "LOOPBACK-REQUEST",
  )
) {
  throw new Error("Unexpected browser error or backend request");
}

console.log("PASS verify-siop: native SIOPv2 against static dist");
