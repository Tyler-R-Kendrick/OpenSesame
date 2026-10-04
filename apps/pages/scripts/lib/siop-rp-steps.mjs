/**
 * What a person, and a relying party, do in the cross-origin SIOP journeys
 * (ADR 0161), shared by the Node and single-page relying parties.
 *
 * Every refusal the RP kit makes is provoked through the real ceremony, not
 * by calling the kit: a wrong nonce, audience or redirect_uri is a request
 * the browser really sends, a tampered signature is a response the browser
 * really posts, an expired token is minted by a browser whose clock is two
 * hours back.
 */
import { expect } from "@playwright/test";

const VAULT_PASSWORD = "Cedar-lantern-47-river!";
const NAVIGATION_TIMEOUT = 15_000;

/** What Pages was asked, and what it answered with, as a relying party sees it. */
export function watch(page, issuer, rpOrigin) {
  const asked = [];
  const answered = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.url().startsWith(`${issuer}?`))
      asked.push(new URL(request.url()));
  });
  // The fragment is the response. It is gone from the address bar a moment
  // after the relying party's page loads, so read it at commit.
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = new URL(frame.url());
    if (url.origin === rpOrigin && url.hash.length > 1) answered.push(url.href);
  });
  return { asked, answered };
}

/** Every load locks the vault: unlock it if that is what arrived. */
export async function unlockIfAsked(page) {
  const password = page.getByLabel("Password", { exact: true });
  const reached = page.getByRole("heading", {
    name: /Self-issued sign-in to|Invalid Self-Issued/,
  });
  await Promise.race([
    password.waitFor({ state: "visible", timeout: 30_000 }),
    reached.waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  if (await password.isVisible()) {
    await password.fill(VAULT_PASSWORD);
    await password.press("Enter");
    await expect(password).not.toBeVisible();
  }
}

async function chooseAndVerify(page, personName) {
  await expect(
    page.getByRole("heading", { name: /Self-issued sign-in to/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .getByLabel("Person", { exact: true })
    .selectOption({ label: personName });
  await page
    .getByRole("button", { name: "Verify with passkey", exact: true })
    .click();
  const allow = page.getByRole("button", {
    name: "Allow Self-Issued sign-in",
    exact: true,
  });
  await expect(allow).toBeVisible({ timeout: 30_000 });
  return allow;
}

/** Leave the page the relying party sent us to, answering as the person. */
export async function answer(page, personName, rpOrigin, how = "allow") {
  await unlockIfAsked(page);
  const leaves = () =>
    page.waitForURL((url) => url.origin === rpOrigin, {
      timeout: NAVIGATION_TIMEOUT,
    });
  if (how === "deny") {
    const deny = page.getByRole("button", { name: "Deny", exact: true });
    await expect(deny).toBeVisible({ timeout: 30_000 });
    await Promise.all([leaves(), deny.click()]);
    return;
  }
  const allow = await chooseAndVerify(page, personName);
  await Promise.all([leaves(), allow.click()]);
}

/**
 * `page.goto` after a navigation this journey itself aborted: the aborted one
 * lands on the browser's error page and can cut the next one short.
 */
export async function gotoAfterAbort(page, url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url);
      return;
    } catch (failure) {
      const interrupted = /interrupted by another navigation/.test(
        failure.message,
      );
      if (!interrupted || attempt === 3) throw failure;
    }
  }
}

const BINDING_COOKIE = "__Host-siop_binding";

/**
 * The binding cookie as this browser holds it, or null. The jar is read whole:
 * filtering it by an `http` URL would hide a `Secure` cookie even though
 * Chromium treats loopback as a secure context and keeps it.
 */
export async function bindingCookieOf(context, rpUrl) {
  const { hostname } = new URL(rpUrl);
  const held = (await context.cookies()).find(
    (cookie) => cookie.name === BINDING_COOKIE && cookie.domain === hostname,
  );
  return held ?? null;
}

/**
 * What the RP's own start route sends the browser to, read without following
 * it. Asked through the *browser context's* own request client, so the binding
 * cookie the RP sets lands in that browser's jar exactly as a followed
 * redirect would put it there: the login is this browser's.
 */
export async function startLogin(context, rpUrl, { clientId, callback } = {}) {
  const query = new URLSearchParams();
  if (clientId !== undefined) query.set("client_id", clientId);
  if (callback !== undefined) query.set("callback", callback);
  const suffix = query.size === 0 ? "" : `?${query}`;
  const response = await context.request.get(`${rpUrl}/auth/start${suffix}`, {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  const url = new URL(response.headers().location ?? "");
  return {
    url,
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
  };
}

/** A login started by somebody else's client: its cookie is theirs, not the browser's. */
export async function startLoginElsewhere(rpUrl) {
  const response = await fetch(`${rpUrl}/auth/start`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.status).toBe(302);
  const url = new URL(response.headers.get("location") ?? "");
  const header = response.headers.get("set-cookie") ?? "";
  return {
    url,
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    cookie: header.split(";")[0] ?? "",
  };
}

/** What a caller would send the RP's callback, with the cookie it holds (if any). */
export async function post(rpUrl, path, response, cookie = "") {
  const answered = await fetch(`${rpUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ response }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: answered.status, body: await answered.json() };
}

export async function expectVerified(page) {
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "verified",
    { timeout: NAVIGATION_TIMEOUT },
  );
  return JSON.parse(await page.locator("#detail").textContent());
}

export async function expectRefused(page, code) {
  const status = page.locator("#status");
  await expect(status).toHaveAttribute("data-state", "refused", {
    timeout: NAVIGATION_TIMEOUT,
  });
  await expect(status).toHaveAttribute("data-code", code);
}

/** Flip the end of the token's signature as the page posts it. */
export async function tamperPostedSignature(page, rpUrl) {
  await page.route(`${rpUrl}/callback`, async (route, request) => {
    if (request.method() !== "POST") return route.fallback();
    const { response } = JSON.parse(request.postData() ?? "{}");
    const params = new URLSearchParams(response.slice(1));
    const token = params.get("id_token") ?? "";
    params.set(
      "id_token",
      `${token.slice(0, -4)}${token.endsWith("AAAA") ? "BBBB" : "AAAA"}`,
    );
    return route.continue({
      postData: JSON.stringify({ response: `#${params}` }),
    });
  });
}

/** Requests the relying party's server saw since `since`: none, if nothing was issued. */
export function relyingPartyTraffic(harness, since) {
  return harness.log
    .slice(since)
    .filter((row) => row.kind === "passthrough-request");
}
