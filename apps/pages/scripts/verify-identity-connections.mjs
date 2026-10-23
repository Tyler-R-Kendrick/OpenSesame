/** Browser settings → real BetterAuth/OIDC sockets → admitted solution identity. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import {
  liveIdentityPage,
  startIdentityAppServer,
} from "./lib/identity-browser-server.mjs";
import {
  startBetterAuth,
  startOidc,
} from "./lib/identity-connection-fixtures.mjs";
import {
  allowLoopbackDevelopment,
  coldNativeSignIn,
  extraNativeFlows,
} from "./lib/identity-native-browser-flows.mjs";
import { sealWithPin, unlockWithPin, waitOpen } from "./lib/pages-journey.mjs";
import { createHarness } from "./lib/static-origin-harness.mjs";
import { startSupabaseWireFixture } from "./lib/supabase-wire-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.PAGES_VERIFY_DIST ?? path.resolve(here, "../dist");
const out = path.resolve(
  process.env.PAGES_VERIFY_OUT ??
    path.join(here, "../../../work/identity-connections-browser"),
);
const origin = "http://localhost:41899";
const base = process.env.VITE_BASE ?? "/OpenSesame/";
if (!fs.existsSync(path.join(dist, "index.html")))
  throw new Error(`Build Pages first: missing ${dist}`);
fs.mkdirSync(out, { recursive: true });
for (const name of ["failure.png", "failure.txt", "failure.dom.json"])
  fs.rmSync(path.join(out, name), { force: true });
const harness = createHarness({ dist, origin, base, out });
const { check, failures, log, setStep } = harness;
const better = await startBetterAuth(origin);
const oidc = await startOidc(origin, base);
const supabase = await startSupabaseWireFixture(origin);
const appServer = await startIdentityAppServer(dist, origin, base);
const browser = await harness.launch({ args: ["--no-sandbox"] });

async function visit(page, provider) {
  await page.evaluate(
    (href) => {
      history.pushState({}, "", href);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    `${base}settings/${provider ? `connections/${provider}` : "integrations"}`,
  );
}
async function enableConnections(page) {
  await page.evaluate((href) => {
    history.pushState({}, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}settings/features`);
  const toggle = page.getByRole("switch", { name: "Connections", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-checked")) !== "true")
    await toggle.click();
  await page.waitForTimeout(900);
}
async function configured(page, provider) {
  await visit(page, provider);
  const labels = {
    "byo-identity": "BYO Identity",
    "better-auth": "Better Auth",
    supabase: "Supabase",
    "neon-auth": "Neon Auth",
    clerk: "Clerk",
    auth0: "Auth0",
    workos: "WorkOS",
    okta: "Okta",
  };
  await page
    .getByRole("heading", { name: labels[provider], exact: true })
    .waitFor();
  await page.getByLabel("Connection name", { exact: true }).waitFor();
}
async function snapshot(page, name) {
  await page.screenshot({
    path: path.join(out, `${name}.png`),
    fullPage: true,
  });
  fs.writeFileSync(
    path.join(out, `${name}.txt`),
    await page.locator("body").innerText(),
  );
  fs.writeFileSync(
    path.join(out, `${name}.dom.json`),
    JSON.stringify(
      await page.evaluate(() => ({
        status: [
          ...document.querySelectorAll('[role="img"], [role="alert"]'),
        ].map((node) => ({
          label: node.getAttribute("aria-label"),
          text: node.textContent,
        })),
        fields: [...document.querySelectorAll("main input, main select")].map(
          (node) => ({
            label: node.labels?.[0]?.textContent?.trim(),
            value: node.type === "password" ? "[redacted]" : node.value,
          }),
        ),
      })),
      null,
      2,
    ),
  );
}
async function save(page) {
  await page
    .getByRole("button", { name: "Save identity connection", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Identity sign-in", exact: true })
    .waitFor();
}

try {
  for (const width of [1280, 390]) {
    setStep(`${width}-configuration`);
    const { page, context } = await liveIdentityPage(
      browser,
      origin,
      [better.issuer, oidc.issuer, supabase.origin],
      harness.record,
    );
    await allowLoopbackDevelopment(page, origin);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
    await sealWithPin(page);
    await enableConnections(page);
    await visit(page);
    for (const label of [
      "Better Auth",
      "Supabase",
      "Neon Auth",
      "Clerk",
      "BYO Identity",
      "Auth0",
      "WorkOS",
      "Okta",
    ]) {
      await expect(
        page.getByRole("link", { name: new RegExp(`^${label}$`) }).first(),
      ).toBeVisible();
      check(true, `${width}: identity catalog includes ${label}`);
    }
    await snapshot(page, `${width}-identity-catalog`);
    for (const [provider, field] of [
      ["better-auth", "Auth API base URL"],
      ["supabase", "Project URL"],
      ["neon-auth", "Auth API base URL"],
      ["clerk", "Issuer URL"],
      ["auth0", "Issuer URL"],
      ["workos", "Issuer URL"],
      ["okta", "Issuer URL"],
    ]) {
      await configured(page, provider);
      await page
        .getByLabel("Connection name", { exact: true })
        .fill(`Editable ${provider}`);
      await page
        .getByLabel(field, { exact: true })
        .fill("https://idp.example.test");
      await expect(page.getByLabel(field, { exact: true })).toHaveValue(
        "https://idp.example.test",
      );
      check(true, `${width}: ${provider} configuration is editable`);
    }
    await configured(page, "byo-identity");
    for (const [protocol, field] of [
      ["oidc", "Issuer URL"],
      ["saml", "Identity provider entity ID"],
      ["ldap", "LDAP server URL"],
      ["better-auth", "Auth API base URL"],
      ["supabase", "Project URL"],
    ]) {
      await page.getByLabel("Protocol", { exact: true }).selectOption(protocol);
      await expect(page.getByLabel(field, { exact: true })).toBeVisible();
      if (protocol === "saml")
        await expect(
          page.getByLabel("Service provider entity ID", { exact: true }),
        ).toBeVisible();
      check(true, `${width}: BYO ${protocol} composes the common fields`);
      await snapshot(page, `${width}-byo-${protocol}`);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    check(!overflow, `${width}: configuration fits the viewport`);

    setStep(`${width}-betterauth-network`);
    await configured(page, "better-auth");
    await page
      .getByLabel("Connection name", { exact: true })
      .fill(`Real Better Auth ${width}`);
    await page
      .getByLabel("Auth API base URL", { exact: true })
      .fill(better.baseUrl);
    await page
      .getByRole("button", { name: "Test identity connection", exact: true })
      .click();
    await expect(
      page.getByRole("img", { name: /publishes signing keys/ }).first(),
    ).toBeVisible();
    await save(page);
    await page
      .getByLabel("Email address", { exact: true })
      .fill(better.credentials.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(better.credentials.password);
    await page
      .getByRole("button", {
        name: `Sign in to Real Better Auth ${width}`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("img", { name: "Signed in", exact: true }).first(),
    ).toBeVisible();
    await waitOpen(page);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    for (const endpoint of [
      "/api/auth/jwks",
      "/api/auth/sign-in/email",
      "/api/auth/get-session",
      "/api/auth/token",
    ]) {
      check(
        better.requests.some((request) => request.path === endpoint),
        `${width}: real BetterAuth socket received ${endpoint}`,
      );
    }
    check(
      (await context.cookies(better.issuer)).some((cookie) =>
        cookie.name.includes("session_token"),
      ),
      `${width}: provider session cookie exists`,
    );
    await snapshot(page, `${width}-betterauth-signed-in`);
    await coldNativeSignIn({
      page,
      origin,
      base,
      width,
      better,
      check,
      waitOpen,
    });
    check(
      await page.evaluate(
        (password) =>
          !JSON.stringify(Object.values(localStorage)).includes(password),
        better.credentials.password,
      ),
      `${width}: login password is absent from persistent browser storage`,
    );
    await configured(page, "clerk");
    await configured(page, "better-auth");
    await expect(
      page.getByLabel("Auth API base URL", { exact: true }),
    ).toHaveValue(better.baseUrl);
    await expect(
      page.getByLabel("Connection name", { exact: true }),
    ).toHaveValue(`Real Better Auth ${width}`);
    check(
      true,
      `${width}: saved identity configuration survives leaving and returning`,
    );
    await page
      .getByRole("button", { name: "Remove identity connection", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Confirm remove identity connection",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("region", { name: "Identity sign-in", exact: true }),
    ).toHaveCount(0);
    check(
      better.requests.some((request) => request.path === "/api/auth/sign-out"),
      `${width}: remove revokes the real BetterAuth provider session`,
    );
    check(
      !(await context.cookies(better.issuer)).some((cookie) =>
        cookie.name.includes("session_token"),
      ),
      `${width}: provider session cookie is revoked`,
    );
    await extraNativeFlows({
      page,
      width,
      better,
      supabase,
      configured,
      save,
      snapshot,
      check,
    });
    await context.close();
  }

  setStep("oidc-authorization-code-network");
  const { page, context } = await liveIdentityPage(
    browser,
    origin,
    [oidc.issuer],
    harness.record,
  );
  await allowLoopbackDevelopment(page, origin);
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await enableConnections(page);
  await configured(page, "byo-identity");
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("Real BYO OIDC");
  await page.getByLabel("Issuer URL", { exact: true }).fill(oidc.issuer);
  await page
    .getByLabel("Public client ID", { exact: true })
    .fill(oidc.clientId);
  await save(page);
  await Promise.all([
    page.waitForResponse(
      (response) => response.url() === `${oidc.issuer}/token` && response.ok(),
      { timeout: 30_000 },
    ),
    page
      .getByRole("button", { name: "Sign in to Real BYO OIDC", exact: true })
      .click(),
  ]);
  await page.waitForURL(`${origin}${base}**`, { timeout: 30_000 });
  await unlockWithPin(page);
  await expect(
    page.getByText("OIDC Browser Identity", { exact: true }).first(),
  ).toBeVisible();
  for (const endpoint of [
    "/.well-known/openid-configuration",
    "/auth",
    "/token",
    "/jwks",
  ]) {
    check(
      oidc.requests.some((request) => request.path === endpoint),
      `OIDC provider socket received ${endpoint}`,
    );
  }
  await snapshot(page, "byo-oidc-admitted");
  await context.close();
} catch (error) {
  const lastPage = browser.contexts().at(-1)?.pages().at(-1);
  if (lastPage) await snapshot(lastPage, "failure");
  failures.push(`[${harness.step()}] ${error.stack ?? error}`);
} finally {
  await browser.close();
  await better.close();
  await oidc.close();
  await supabase.close();
  await appServer.close();
}
for (const entry of log.filter((entry) =>
  ["PAGE-ERROR", "console-error", "HTTP-ERROR", "MISSING-ASSET"].includes(
    entry.kind,
  ),
))
  failures.push(`${entry.kind}: ${entry.detail}`);
for (const error of [...better.errors, ...oidc.errors, ...supabase.errors])
  failures.push(`IdP fixture: ${error}`);
fs.writeFileSync(
  path.join(out, "results.json"),
  JSON.stringify(
    {
      failures,
      log,
      betterAuthRequests: better.requests,
      oidcRequests: oidc.requests,
      supabaseWireRequests: supabase.requests,
    },
    null,
    2,
  ),
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS identity settings; real BetterAuth/OIDC servers; Neon/GoTrue protocol fixture browser sign-in; evidence ${out}`,
  );
