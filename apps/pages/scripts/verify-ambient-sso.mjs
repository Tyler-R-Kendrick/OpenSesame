// Hermetic ambient SSO checks against the built Pages bundle.
//
//   VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//     pnpm --filter @opensesame/pages verify:ambient-sso
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const ORIGIN = process.env.PAGES_ORIGIN ?? "https://tyler-r-kendrick.github.io";
const BASE = process.env.VITE_BASE ?? "/OpenSesame/";
const TENANT = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const CLIENT_ID = "00000000-0000-0000-0000-000000000001";
const PROVIDER_KEY = `entra|${ISSUER}|${CLIENT_ID}|`;

const failures = [];
const log = [];
const check = (cond, what) => {
  log.push({ kind: cond ? "PASS" : "FAIL", what });
  if (!cond) failures.push(what);
};

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`no build at ${DIST} — run the pages build first`);
  process.exit(2);
}

const distFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else distFiles.push(full);
  }
};
walk(DIST);

const bridge =
  distFiles.find((file) => /auth\/redirect\.html$/.test(file)) ??
  distFiles.find((file) => file.endsWith("redirect.html"));
check(Boolean(bridge), "MSAL redirect bridge HTML is in dist/");
if (bridge) {
  const html = fs.readFileSync(bridge, "utf8");
  check(!/createRoot|react-dom/.test(html), "bridge HTML does not mount React");
}

function findChromium() {
  if (
    process.env.PLAYWRIGHT_CHROMIUM &&
    fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM)
  ) {
    return process.env.PLAYWRIGHT_CHROMIUM;
  }
  const cache = path.join(process.env.HOME ?? "", ".cache/ms-playwright");
  if (!fs.existsSync(cache)) return null;
  for (const name of fs.readdirSync(cache).sort().reverse()) {
    if (!name.startsWith("chromium")) continue;
    const root = path.join(cache, name);
    for (const candidate of [
      path.join(root, "chrome-linux-arm64/chrome"),
      path.join(root, "chrome-linux/chrome"),
      path.join(root, "chrome-linux64/chrome"),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const chromium = findChromium();
if (!chromium) {
  log.push({
    kind: "SKIP",
    what: "headless Chromium unavailable — browser journeys not run",
  });
  console.log(JSON.stringify({ log, failures, skipped: true }, null, 2));
  if (failures.length) process.exit(1);
  process.exit(0);
}

const { chromium: pw } = await import("@playwright/test");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function serveDist(url) {
  const rel = url.pathname.startsWith(BASE)
    ? url.pathname.slice(BASE.length)
    : url.pathname.slice(1);
  const file = path.join(DIST, rel);
  if (rel && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    return {
      status: 200,
      headers: {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      },
      body: fs.readFileSync(file),
    };
  }
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: fs.readFileSync(path.join(DIST, "index.html")),
  };
}

const enterpriseConfig = {
  ambientAuth: {
    schemaVersion: 1,
    mode: "deployment-selected",
    selectedProviderKey: PROVIDER_KEY,
    allowedTransport: "silent-redirect",
    allowVisibleTopLevel: true,
    providers: [
      {
        providerId: "microsoft",
        issuer: ISSUER,
        clientId: CLIENT_ID,
        label: "Contoso",
      },
    ],
  },
};

const keys = await generateKeyPair("ES256", { extractable: true });
const publicJwk = await exportJWK(keys.publicKey);
publicJwk.kid = "ambient-verify";
publicJwk.use = "sig";
publicJwk.alg = "ES256";

const browser = await pw.launch({ executablePath: chromium, headless: true });

async function withPage(handler) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const counts = { authorize: 0, token: 0, link: 0, join: 0, history: 0 };
  const captured = { nonce: "", state: "", redirectUri: "" };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const result = await handler({
      request,
      url,
      route,
      counts,
      captured,
      enterpriseConfig,
    });
    if (result === "continue") {
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname.endsWith("os-runtime-config.json")) {
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
      }
      return route.fulfill(serveDist(url));
    }
  });
  const page = await context.newPage();
  return { page, context, counts, captured };
}

{
  const forbidden = [];
  const { page, context } = await withPage(async ({ url, route }) => {
    if (
      /login\.microsoftonline\.com|shoo\.dev|127\.0\.0\.1:9090|localhost:9090/.test(
        url.host,
      )
    ) {
      forbidden.push(url.href);
      await route.abort();
      return "done";
    }
    return "continue";
  });
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Continue as guest", exact: true })
    .first()
    .waitFor({ timeout: 20_000 });
  const text = await page.locator("body").innerText();
  check(/Continue as guest/i.test(text), "POL-DEFAULT: guest road is present");
  check(
    /guest/i.test(text) || /Sign in/i.test(text) || /Google/i.test(text),
    "sign-in UI is present",
  );
  check(
    forbidden.length === 0,
    `POL-DEFAULT: zero automatic IdP requests (saw ${forbidden.length})`,
  );
  await context.close();
}

if (bridge) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    return route.fulfill(serveDist(url));
  });
  const bridgePage = await context.newPage();
  await bridgePage.goto(`${ORIGIN}${BASE}auth/redirect.html`, {
    waitUntil: "domcontentloaded",
  });
  const bridgeText = await bridgePage.locator("body").innerText();
  check(
    !/Continue as guest/i.test(bridgeText),
    "WEB-BRIDGE: guest UI is not on the bridge",
  );
  await context.close();
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "*",
};

async function fulfillDiscovery(route) {
  await route.fulfill({
    status: 200,
    headers: { "content-type": "application/json", ...CORS },
    body: JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/discovery/v2.0/keys`,
    }),
  });
}

async function fulfillAuthorize(route, url, counts, captured) {
  counts.authorize += 1;
  captured.nonce = url.searchParams.get("nonce") ?? "";
  captured.state = url.searchParams.get("state") ?? "";
  captured.redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const back = new URL(captured.redirectUri);
  back.searchParams.set("code", "ambient-code");
  back.searchParams.set("state", captured.state);
  await route.fulfill({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><script>location.replace(${JSON.stringify(back.toString())})</script>`,
  });
}

async function fulfillToken(route, captured, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({
    sub: "entra-sub-1",
    nonce: captured.nonce,
    name: "Pat Contoso",
  })
    .setProtectedHeader({ alg: "ES256", kid: "ambient-verify", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  await route.fulfill({
    status: 200,
    headers: { "content-type": "application/json", ...CORS },
    body: JSON.stringify({ id_token: idToken, token_type: "Bearer" }),
  });
}

{
  const { page, context, counts, captured } = await withPage(
    async ({ request, url, route, counts, captured }) => {
      if (
        url.origin === ORIGIN &&
        url.pathname.endsWith("os-runtime-config.json")
      ) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(enterpriseConfig),
        });
        return "done";
      }
      if (
        request.method() === "OPTIONS" &&
        url.origin.includes("microsoftonline")
      ) {
        await route.fulfill({ status: 204, headers: CORS });
        return "done";
      }
      if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
        await fulfillDiscovery(route);
        return "done";
      }
      if (
        url.pathname.endsWith("/discovery/v2.0/keys") &&
        url.origin.includes("microsoftonline")
      ) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", ...CORS },
          body: JSON.stringify({ keys: [publicJwk] }),
        });
        return "done";
      }
      if (
        url.pathname.endsWith("/authorize") &&
        url.origin.includes("microsoftonline")
      ) {
        await fulfillAuthorize(route, url, counts, captured);
        return "done";
      }
      if (
        url.pathname.endsWith("/token") &&
        url.origin.includes("microsoftonline")
      ) {
        counts.token += 1;
        await fulfillToken(route, captured, keys.privateKey);
        return "done";
      }
      if (
        /link-identities|federated-session|history|claimProvisional/i.test(
          url.pathname,
        )
      ) {
        counts.link += 1;
        await route.abort();
        return "done";
      }
      if (url.origin !== ORIGIN) {
        await route.abort();
        return "done";
      }
      return "continue";
    },
  );

  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: "networkidle" });
  await page
    .getByText(/Signed in with your organization/i)
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  const body = await page.locator("body").innerText();
  check(
    counts.authorize === 1,
    `POL-ENTERPRISE: exactly one authorize (saw ${counts.authorize})`,
  );
  check(
    counts.token === 1,
    `POL-ENTERPRISE: one token exchange (saw ${counts.token})`,
  );
  check(
    /Signed in with your organization/i.test(body),
    "POL-ENTERPRISE: verified account shown without an app sign-in click",
  );
  check(
    /Continue as guest/i.test(body),
    "guest road remains after ambient SSO",
  );
  check(counts.link === 0, "ID-HISTORY: no link/history/join network calls");
  check(
    !/Vault unlocked/i.test(body),
    "ID-LOCKED: does not claim the vault is unlocked",
  );

  const signOut = page.getByRole("button", { name: "Sign out" });
  check((await signOut.count()) > 0, "authenticated banner offers Sign out");
  if ((await signOut.count()) > 0) {
    await signOut.click();
    await page.waitForTimeout(500);
    const afterOut = await page.locator("body").innerText();
    check(
      /Signed out of this device/i.test(afterOut),
      "LIFE-LOGOUT: local sign-out is visible",
    );
    const beforeReload = counts.authorize;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check(
      counts.authorize === beforeReload,
      `LIFE-RELOAD: no automatic authorize after sign-out (saw ${counts.authorize - beforeReload})`,
    );
  }
  await context.close();
}

await browser.close();
console.log(JSON.stringify({ log, failures, skipped: false }, null, 2));
if (failures.length) process.exit(1);
