// Real Chromium, real Identity HTTP, and the immutable SDK artifact with browser SRI.
// pnpm --filter @opensesame/control-plane exec tsx scripts/verify-static-auth.mjs
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { startFixture } from "./static-auth-browser-fixture.mjs";

const fixture = await startFixture();
let browser;
let stage = "start";
try {
  if (process.argv.includes("--serve")) {
    console.info(`Local browser verification fixture: ${fixture.origin}`);
    await new Promise((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } else {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM,
    });
    for (const scenario of [
      "valid",
      "wrong-nonce",
      "wrong-issuer",
      "wrong-state",
    ]) {
      stage = scenario;
      await verifyScenario(browser, scenario);
    }
    console.info(
      `PASS: Chromium hosted authentication, artifact ${fixture.version}; SRI, actual CORS, code/PKCE, nonce, issuer/state, single-use callback and server code replay.`,
    );
  }
} catch {
  // Browser exceptions may include a callback URL/code. Never print their body/stack.
  console.error(`FAIL: static-auth browser verification at ${stage}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fixture.close();
}

async function captureBrowserWire(context, page, scenario) {
  const pageErrors = [];
  const calls = [];
  let pending;
  let callback;
  page.on("pageerror", () => pageErrors.push("pageerror"));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === fixture.origin && url.searchParams.has("code"))
      callback = url.href;
  });
  await page.exposeFunction("retainPending", (value) => {
    pending = value;
  });
  await context.addInitScript(
    ({ scenario, origin, issuer }) => {
      if (location.origin === origin && location.search.includes("code=")) {
        const callbackUrl = new URL(location.href);
        if (scenario === "wrong-issuer")
          callbackUrl.searchParams.set("iss", `${issuer}/other`);
        if (scenario === "wrong-state")
          callbackUrl.searchParams.set(
            "state",
            "wrong-state-transaction-value",
          );
        history.replaceState(null, "", callbackUrl);
      }
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("opensesame:static-auth:"))
          window.retainPending({ key, value });
        return original.call(this, key, value);
      };
    },
    { scenario, origin: fixture.origin, issuer: fixture.issuer },
  );
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (![fixture.origin, fixture.issuer].includes(url.origin)) {
      pageErrors.push("external request");
      await route.abort();
      return;
    }
    if (url.origin === fixture.issuer && url.pathname === "/auth") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      if (scenario === "wrong-nonce")
        url.searchParams.set("nonce", "wrong-nonce-transaction-value");
    }
    if (url.origin === fixture.origin && url.searchParams.has("code")) {
      callback = url.href;
      if (scenario === "wrong-issuer")
        url.searchParams.set("iss", `${fixture.issuer}/other`);
      if (scenario === "wrong-state")
        url.searchParams.set("state", "wrong-state-transaction-value");
    }
    await route.continue({ url: url.href });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      url.origin === fixture.issuer &&
      ["/token", "/jwks"].includes(url.pathname)
    ) {
      calls.push({
        path: url.pathname,
        status: response.status(),
        origin: response.request().headers().origin,
        allowOrigin: response.headers()["access-control-allow-origin"],
      });
    }
  });
  return { pageErrors, calls, transaction: () => ({ pending, callback }) };
}

async function consentInBrowser(page, scenario) {
  stage = `${scenario}: RP load`;
  await page.goto(fixture.origin);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  stage = `${scenario}: real guest login`;
  const disclosure = page.getByText("Continue without a provider", {
    exact: true,
  });
  if (await disclosure.count()) await disclosure.click();
  await page
    .getByRole("button", { name: "Start a session", exact: true })
    .click();
  stage = `${scenario}: exact RP consent`;
  await page.locator('form[action$="/confirm"] button').click();
}

async function verifyScenario(browser, scenario) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { pageErrors, calls, transaction } = await captureBrowserWire(
    context,
    page,
    scenario,
  );
  try {
    await consentInBrowser(page, scenario);
    stage = `${scenario}: validated outcome`;
    await page
      .getByRole("status")
      .filter({ hasText: scenario === "valid" ? "Verified" : "Refused" })
      .waitFor();
    assert.equal(page.url(), `${fixture.origin}/opensesame/callback`);
    assert.equal(await page.evaluate(() => sessionStorage.length), 0);
    assert.deepEqual(pageErrors, []);
    const sessions = await page.evaluate(() => window.results);
    if (scenario !== "valid") {
      assert.deepEqual(sessions, []);
      if (["wrong-state", "wrong-issuer"].includes(scenario))
        assert.equal(calls.length, 0);
      return;
    }
    assert.equal(sessions.length, 1);
    assert.deepEqual(Object.keys(sessions[0]).sort(), ["expiresAt", "subject"]);
    assert.ok(sessions[0].subject);
    assert.ok(sessions[0].expiresAt > Date.now());
    assert.deepEqual(
      calls.map(({ path, status }) => ({ path, status })),
      [
        { path: "/token", status: 200 },
        { path: "/jwks", status: 200 },
      ],
    );
    for (const call of calls) {
      assert.equal(call.origin, fixture.origin);
      assert.equal(call.allowOrigin, fixture.origin);
    }
    stage = "valid: callback captured";
    const { callback, pending } = transaction();
    assert.ok(callback);
    stage = "valid: pending transaction captured";
    assert.ok(pending);
    stage = "valid: client callback replay";
    await page.goto(callback);
    await page.getByRole("status").filter({ hasText: "Refused" }).waitFor();
    assert.equal(calls.length, 2);
    stage = "valid: server code replay";
    await page.evaluate(
      ({ key, value }) => sessionStorage.setItem(key, value),
      pending,
    );
    await page.goto(callback);
    await page.getByRole("status").filter({ hasText: "Refused" }).waitFor();
    assert.equal(calls.at(-1).status, 400);
    assert.deepEqual(await page.evaluate(() => window.results), []);
  } finally {
    await context.close();
  }
}
