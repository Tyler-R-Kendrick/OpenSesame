/**
 * People for `verify-quorum-browser.mjs`: one browser context each, with its
 * own CDP virtual authenticator that supports the WebAuthn PRF extension, and
 * the real desk running in the page over `navigator.credentials`.
 *
 * Chromium's virtual authenticator is not a hardware key. It does run the
 * browser's own WebAuthn stack: real `create`/`get`, real clientDataJSON,
 * authenticator data and signatures, and the PRF extension as the browser
 * implements it. That is the layer the unit tests' JS authenticator only
 * imitates, so this rig is where an imitation that differs from a browser would
 * show.
 */

import { chromium } from "@playwright/test";
import { EXPECT_TIMEOUT_MS } from "./expect-timeout.mjs";
import { bundle, root } from "./local-iam-rig.mjs";

export const ORIGIN = "https://tyler-r-kendrick.github.io";
export const BASE = "/OpenSesame/";

let cached = null;

/** The desk, bundled once for every page. */
export async function pageBundle() {
  cached ??= await bundle(
    `${root}/apps/pages/scripts/lib/quorum-browser-entry.mjs`,
    "quorumBrowser",
  );
  return cached;
}

export async function launch() {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    headless: true,
  });
}

/** The virtual key: CTAP2.1 over USB, proves the user, answers a touch by itself. Shared with the screens gate. */
export const AUTHENTICATOR = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "usb",
  hasResidentKey: false,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

export class StepError extends Error {
  constructor(step, answer) {
    super(
      `${step}: ${answer.name}${answer.code ? ` (${answer.code})` : ""}: ${answer.message}`,
    );
    this.step = step;
    this.answer = answer;
  }
}

export class Person {
  constructor(name, page, cdp, authenticatorId) {
    this.name = name;
    this.page = page;
    this.cdp = cdp;
    this.authenticatorId = authenticatorId;
  }

  /** Run a desk step in this person's page; throws `StepError` if it refuses. */
  async run(step, ...args) {
    const answer = await this.attempt(step, ...args);
    if (!answer.ok) throw new StepError(step, answer);
    return answer.value;
  }

  /** The same, but hands back the refusal instead of throwing. */
  async attempt(step, ...args) {
    return this.page.evaluate(
      ([name, rest]) => globalThis.__q.run(name, ...rest),
      [step, args],
    );
  }

  /** Pass time on this person's clock. */
  async skew(ms) {
    await this.page.evaluate((value) => globalThis.__q.skew(value), ms);
  }

  /** The key stops proving a PIN or biometric. */
  async userVerified(isUserVerified) {
    await this.cdp.send("WebAuthn.setUserVerified", {
      authenticatorId: this.authenticatorId,
      isUserVerified,
    });
  }

  /** Lose the key and carry a new one: the credentials it held are gone. */
  async replaceKey({ prf = true } = {}) {
    await this.cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: this.authenticatorId,
    });
    const { authenticatorId } = await this.cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      { options: { ...AUTHENTICATOR, hasPrf: prf } },
    );
    this.authenticatorId = authenticatorId;
  }

  async close() {
    await this.page.context().close();
  }
}

/** A person at `origin` (default: the production origin) whose key does or does not do PRF. */
export async function person(browser, name, options = {}) {
  const { origin = ORIGIN, prf = true } = options;
  const code = await pageBundle();
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === `${BASE}q.js`) {
      return route.fulfill({ contentType: "text/javascript", body: code });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>${name}</title><script src="${BASE}q.js"></script>`,
    });
  });
  const page = await context.newPage();
  // The shared bound: a slow runner gets the same patience as every other gate.
  page.setDefaultTimeout(EXPECT_TIMEOUT_MS);
  const failures = [];
  page.on("pageerror", (error) => failures.push(`${name}: ${error.message}`));
  await page.goto(`${origin}${BASE}`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    { options: { ...AUTHENTICATOR, hasPrf: prf } },
  );
  const who = new Person(name, page, cdp, authenticatorId);
  who.failures = failures;
  return who;
}
