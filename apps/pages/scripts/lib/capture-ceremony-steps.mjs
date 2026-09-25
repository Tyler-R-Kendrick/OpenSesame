/**
 * Capture verbs for a ceremony a link opens (`/device`, ADR 0140), kept
 * beside `capture-evidence.mjs`'s own, and the stand-in Identity API such a
 * journey needs in an environment that has none.
 *
 * Every verb here is optional in the same sense `pressOptional` is: the base
 * build has no such screen, and a journey walks both builds with the same
 * steps. A step that finds nothing to do on the base does nothing there.
 */

/**
 * Answer the Identity API routes a device approval walks, at `origin`, for
 * one page. This environment has no Identity API, and a signed-in session is
 * what the screen is gated on; the README of any journey that uses this must
 * say that the Identity API was a stand-in. Only these routes answer:
 *
 * - `GET /v1/principals/me` → 401 (no cookie session to resume);
 * - `POST /v1/principals/provisional` → a provisional principal and bearer;
 * - `POST /v1/device/approve` → the proxy's `{ ok, status }`;
 * - `GET /v1/health/live` → live.
 *
 * Anything else is a 404, so a call the journey did not expect shows up as
 * a failure rather than quietly succeeding.
 */
export async function identityStub(page, { origin, pagesOrigin, calls }) {
  const cors = {
    "access-control-allow-origin": pagesOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  await page.route(`${origin}/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: cors });
    }
    calls.push(
      `${request.method()} ${url.pathname} ${request.postData() ?? ""}`,
    );
    const json = (status, body) =>
      route.fulfill({
        status,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const at = `${request.method()} ${url.pathname}`;
    if (at === "GET /v1/principals/me")
      return json(401, { error: "unauthorized" });
    if (at === "POST /v1/principals/provisional") {
      return json(201, {
        principalId: "prn_evidence",
        accessToken: "evidence-bearer",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (at === "POST /v1/device/approve")
      return json(200, { ok: true, status: 200 });
    if (at === "GET /v1/health/live") return json(200, { status: "live" });
    return json(404, { error: "not_found" });
  });
}

/**
 * A journey through an Identity-plane ceremony names a stand-in API
 * (`journey.identityStub`): route it for this page and print each call it
 * answers, as it answers it, so the capture log records what the page sent.
 * No stand-in, no routing.
 */
export async function journeyIdentityStub(page, journey, pagesOrigin) {
  if (!journey.identityStub) return;
  const calls = { push: (call) => console.log(`  identity: ${call}`) };
  await identityStub(page, {
    origin: journey.identityStub,
    pagesOrigin,
    calls,
  });
}

export function ceremonySteps({ press }) {
  return {
    /** Type into a labelled field and leave it, when this build has one. */
    async fillOptional(page, { label, text }) {
      const field = page.getByLabel(label, { exact: true }).first();
      if (!(await field.count())) return;
      await field.fill(text);
      await field.evaluate((node) => node.blur());
      await page.waitForTimeout(600);
    },
    /** Press the key with exactly this name, when this build has one. */
    async pressNamedOptional(page, name) {
      const target = page.getByRole("button", { name, exact: true }).first();
      if (!(await target.count()) || !(await target.isEnabled())) return;
      await press(target);
      await page.waitForTimeout(1200);
    },
    /** A key the way a person presses it, on whatever holds the focus. */
    async key(page, key) {
      await page.keyboard.press(key);
      await page.waitForTimeout(1200);
    },
    /** Print what holds the focus, and whether it shows a ring. */
    async focused(page) {
      const seen = await page.evaluate(() => {
        const node = document.activeElement;
        if (!(node instanceof HTMLElement)) return "nothing";
        const name =
          node.getAttribute("aria-label") ??
          node.getAttribute("id") ??
          node.tagName;
        const box = node.getBoundingClientRect();
        const ring = node.matches(":focus-visible");
        return `${node.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}x${Math.round(box.height)} focus-visible=${ring}`;
      });
      console.log(`  focused: ${seen}`);
    },
    /** Print a field's value, so a sheet's code is read from the browser. */
    async value(page, label) {
      const field = page.getByLabel(label, { exact: true }).first();
      const value = (await field.count()) ? await field.inputValue() : "none";
      console.log(`  value ${label}: ${value}`);
    },
  };
}
