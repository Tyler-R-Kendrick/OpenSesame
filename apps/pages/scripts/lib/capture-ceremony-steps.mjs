/**
 * Capture verbs for a ceremony a link opens (`/device`, ADR 0140), kept
 * beside `capture-evidence.mjs`'s own, and the stand-in Identity API such a
 * journey needs in an environment that has none.
 *
 * Every verb here is optional in the same sense `pressOptional` is: the base
 * build has no such screen, and a journey walks both builds with the same
 * steps. A step that finds nothing to do on the base does nothing there.
 */

import fs from "node:fs";
import path from "node:path";

/** The sealed synthetic drop a journey names (`dropManifest`), or `null`. */
function journeyDropManifest(journey, journeyPath) {
  if (!journey.dropManifest) return null;
  const file = path.resolve(path.dirname(journeyPath), journey.dropManifest);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * The stand-in a journey names (`identityStub`: its origin), installed on
 * `page`. Returns the list each call it answers is recorded in — empty, and
 * nothing installed, for a journey that names none.
 */
export async function stubJourneyIdentity(
  page,
  { journey, journeyPath, pagesOrigin },
) {
  const calls = [];
  if (!journey.identityStub) return calls;
  await identityStub(page, {
    origin: journey.identityStub,
    pagesOrigin,
    calls,
    dropManifest: journeyDropManifest(journey, journeyPath),
  });
  return calls;
}

/** The one ownership claim the stand-in serves (`answerClaims` below). */
const EVIDENCE_CLAIM = {
  id: "clm_evidence",
  type: "resource_bundle",
  state: "presented",
  targetManifestDigest:
    "sha256:3f7a9c1e0b5d4a2f8e6c7b9d0a1f2e3d4c5b6a7980f1e2d3c4b5a69788f0e1d2",
  items: [{ id: "item-1" }, { id: "item-2" }],
};

function bodyOf(request) {
  try {
    return JSON.parse(request.postData() ?? "{}");
  } catch {
    return {};
  }
}

/** Answer the claim routes; `null` when the call is not one of them. */
function answerClaims(at, request, dropManifest) {
  if (at === "POST /v1/claims/present") {
    // A user code beside the bearer is a drop's single presentation.
    if (bodyOf(request).userCode === undefined) return [200, EVIDENCE_CLAIM];
    return dropManifest
      ? [200, { targetManifest: dropManifest }]
      : [404, { error: "not_found" }];
  }
  if (at === `GET /v1/claims/${EVIDENCE_CLAIM.id}`) {
    return [200, EVIDENCE_CLAIM];
  }
  if (at === `POST /v1/claims/${EVIDENCE_CLAIM.id}/complete`) {
    return [200, { ...EVIDENCE_CLAIM, state: "completed" }];
  }
  return null;
}

/**
 * Answer the Identity API routes a ceremony walks, at `origin`, for one page.
 * This environment has no Identity API, and a signed-in session is what the
 * screens are gated on; the README of any journey that uses this must say
 * that the Identity API was a stand-in. Only these routes answer:
 *
 * - `GET /v1/principals/me` → 401 (no cookie session to resume);
 * - `POST /v1/principals/provisional` → a provisional principal and bearer;
 * - `POST /v1/device/approve` → the proxy's `{ ok, status }`;
 * - `POST /v1/claims/present`, `GET /v1/claims/clm_evidence`,
 *   `POST /v1/claims/clm_evidence/complete` → one synthetic claim; a present
 *   carrying a user code is a drop's, answered with `dropManifest` (a sealed
 *   synthetic drop the journey names) when there is one;
 * - `GET /v1/health/live` → live.
 *
 * Anything else is a 404, so a call the journey did not expect shows up as
 * a failure rather than quietly succeeding.
 */
export async function identityStub(
  page,
  { origin, pagesOrigin, calls, dropManifest = null },
) {
  const cors = {
    "access-control-allow-origin": pagesOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers":
      "authorization, content-type, accept, x-claim-token",
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
    const claim = answerClaims(at, request, dropManifest);
    if (claim) return json(claim[0], claim[1]);
    return json(404, { error: "not_found" });
  });
}

/** Verbs for how a link arrives: the address it paints with, the guest road. */
function arrivalSteps({ press }) {
  return {
    /**
     * Record the address at the moment the app first draws into `#root`, on
     * every load of this page from now on. The mutation callback runs before
     * that frame paints, so this is the address the first painted app had.
     */
    async watchFirstRender(page) {
      await page.addInitScript(() => {
        const seen = new MutationObserver(() => {
          if (!document.getElementById("root")?.firstChild) return;
          sessionStorage.setItem("evidence.first-render", location.href);
          seen.disconnect();
        });
        seen.observe(document, { childList: true, subtree: true });
      });
    },
    /** Print what `watchFirstRender` saw for the latest load. */
    async firstRenderAddress(page) {
      const href = await page.evaluate(() =>
        sessionStorage.getItem("evidence.first-render"),
      );
      console.log(`  first render address: ${href ?? "none"}`);
    },
    /** Let time pass, for a claim about what still holds later (seconds). */
    async wait(page, seconds) {
      await page.waitForTimeout(seconds * 1000);
    },
    /**
     * Take the guest road from whatever this build shows first: the
     * capability review, the front door's Continue as guest, or the unlock
     * screen's Unlock for a guest vault this page already made. A build that
     * drew its route without a locked screen in front has nothing to press.
     */
    async guestOptional(page) {
      const apply = page.getByTestId("capability-apply");
      const road = [
        apply,
        page.getByRole("button", { name: "Continue as guest", exact: true }),
        page.getByRole("button", { name: "Unlock", exact: true }),
      ];
      let pressed = null;
      for (const key of road) {
        const first = key.first();
        if (await first.isVisible().catch(() => false)) {
          pressed = first;
          break;
        }
      }
      if (!pressed) {
        console.log("  guest: nothing in front of this route");
        return;
      }
      await press(pressed);
      await page.waitForTimeout(1500);
      if (
        await apply
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        await press(apply.first());
        await page
          .getByTestId("capability-review")
          .waitFor({ state: "detached", timeout: 20_000 });
      }
      await page.waitForTimeout(1200);
    },
  };
}

export function ceremonySteps({ press }) {
  return {
    ...arrivalSteps({ press }),
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
