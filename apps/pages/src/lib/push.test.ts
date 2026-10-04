/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { pushNotificationBody, reviewUrlFromPayload } from "./push.js";

const here = dirname(fileURLToPath(import.meta.url));

const SCOPE = "https://example.github.io/OpenSesame/";

/**
 * Everything a payload must never be able to put on a lock screen, in one
 * hostile object.
 */
const HOSTILE = {
  kind: "authorization_request",
  action: "review",
  ref: "rzv_9f2a4c",
  // None of the below may reach the notification, the tag, or the URL.
  authorizationDetails: [
    { type: "connector", actions: ["rotate"], locations: ["prod-signer"] },
  ],
  bindingMessage: "Rotate the production signing key",
  comparisonValue: "424242",
  principalId: "prin_01JABCDEF",
  accessToken: "osc_at_should_never_be_here",
  title: "Attacker chosen title",
  body: "Attacker chosen body",
};

describe("what a push may say on a lock screen", () => {
  it("renders a minimal body carrying none of the payload's content", () => {
    const view = pushNotificationBody(HOSTILE);
    expect(view.title).toBe("Authorization requested");
    expect(view.body).toBe("Open OpenSesame to review it.");

    const rendered = `${view.title} ${view.body} ${view.tag}`;
    expect(rendered).not.toContain("prod-signer");
    expect(rendered).not.toContain("rotate");
    expect(rendered).not.toContain("Rotate the production signing key");
    expect(rendered).not.toContain("connector");
    expect(rendered).not.toContain("424242");
    expect(rendered).not.toContain("prin_01JABCDEF");
    expect(rendered).not.toContain("osc_at_should_never_be_here");
    expect(rendered).not.toContain("Attacker chosen");
    // Only the opaque reference travels onward.
    expect(view.data).toEqual({ ref: "rzv_9f2a4c" });
  });

  it("cannot be talked into a body the payload supplied", () => {
    const view = pushNotificationBody({
      kind: "not_a_kind",
      action: "Approve $5,000,000 transfer",
      ref: "rzv_1",
    });
    expect(view.title).toBe("Authorization requested");
    expect(view.body).toBe("Open OpenSesame.");
    expect(view.body).not.toContain("5,000,000");
  });

  it("stays generic for a malformed, empty, or stale push", () => {
    for (const payload of [null, undefined, "", 7, [], { ref: 12 }]) {
      const view = pushNotificationBody(overlapCast(payload));
      expect(view.title).toBe("Authorization requested");
      expect(view.body).toBe("Open OpenSesame.");
      expect(view.data.ref).toBe("");
      expect(view.tag).toBe("opensesame-approval");
    }
  });

  it("titles a decision and a security event without describing either", () => {
    expect(
      pushNotificationBody({
        kind: "authorization_decision",
        action: "decided",
      }).title,
    ).toBe("A request you sent was decided");
    expect(pushNotificationBody({ kind: "security_event" }).title).toBe(
      "Security alert",
    );
  });
});

describe("where a click lands", () => {
  it("builds the review URL from the opaque reference and carries no token", () => {
    const url = reviewUrlFromPayload(HOSTILE, SCOPE);
    expect(url).toBe("https://example.github.io/OpenSesame/approve/rzv_9f2a4c");
    expect(url).not.toContain("osc_at_should_never_be_here");
    expect(url).not.toContain("424242");
    expect(url).not.toContain("prin_01JABCDEF");
    expect(url).not.toContain("token");
    expect(url).not.toContain("?");
    expect(url).not.toContain("#");
  });

  it("refuses a reference that is really a path, an origin, or a query", () => {
    for (const ref of [
      "../../evil",
      "/absolute",
      "https://evil.example/steal",
      "ok?token=osc_at_leak",
      "ok#token=osc_at_leak",
      "with space",
      "a".repeat(129),
    ]) {
      const url = reviewUrlFromPayload({ ref }, SCOPE);
      // Anything that is not an opaque reference lands on the app's own front
      // door — never off-origin, never carrying what it tried to smuggle.
      expect(url).toBe(SCOPE);
    }
  });

  it("lands on the app when a stale push has no reference at all", () => {
    expect(reviewUrlFromPayload({ kind: "authorization_request" }, SCOPE)).toBe(
      SCOPE,
    );
    expect(reviewUrlFromPayload(null, SCOPE)).toBe(SCOPE);
  });
});

/**
 * The push worker is three files now, not one: `sw-push.ts` installs the core
 * worker (`sw/core.ts`, which owns install/activate/fetch/message) and then
 * the push handlers (`sw/push-handlers.ts`, the only place a notification is
 * rendered — `sw.ts`, the core-only variant, must not import them). The sweep
 * below is the same sweep, over the whole of what the push variant ships.
 */
describe("the service worker's own listeners", () => {
  const source = (name: string) => readFileSync(join(here, "..", name), "utf8");
  const core = source("sw/core.ts");
  const sw = [source("sw-push.ts"), source("sw/push-handlers.ts"), core].join(
    "\n",
  );
  // Comments explain what must not happen and therefore name it; the sweep is
  // about what the worker actually executes.
  const code = sw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("keeps the push handlers out of the core-only worker (PWA-01)", () => {
    const coreOnly = source("sw.ts");
    expect(coreOnly).not.toContain("push-handlers");
    expect(coreOnly).not.toContain("showNotification");
    expect(source("sw-push.ts")).toContain("installPushHandlers(sw)");
  });

  it("ships none of the document's enrolment code", () => {
    expect(sw).not.toContain("push-enrolment");
    expect(sw).not.toContain("sdk-browser");
  });

  it("renders notifications only through the helper", () => {
    // The single call to showNotification is fed by pushNotificationBody, so
    // there is no second path by which payload text could reach a screen.
    expect(sw.match(/showNotification\(/g)).toHaveLength(1);
    expect(sw).toContain("pushNotificationBody(pushPayload(event))");
    expect(sw).toMatch(/showNotification\(view\.title/);
    // Nothing in the worker reads a descriptive field off the payload.
    expect(code).not.toMatch(/authorizationDetails|bindingMessage/);
    expect(code).not.toMatch(/comparisonValue|principalId|accessToken/);
    expect(code).not.toMatch(/Bearer\s/);
  });

  it("builds the click target only from the helper and its own scope", () => {
    expect(sw).toContain("reviewUrlFromPayload(");
    expect(sw).toContain("sw.registration.scope");
    // No URL is assembled from payload text anywhere in the worker.
    expect(code).not.toMatch(/openWindow\((?!url\))/);
  });

  it("leaves the pre-existing listeners intact", () => {
    for (const listener of ["install", "activate", "fetch"]) {
      expect(core).toContain(`sw.addEventListener("${listener}"`);
    }
    // The single fixed cache name became one this application builds for its
    // own scope, release and variant; the worker still never reaches for a
    // cache it did not name itself.
    expect(core).toContain('from "./cache-names.js"');
    expect(code).not.toMatch(/caches\.match\(/);
    expect(code).not.toMatch(/"opensesame-pages[-:][^"]*"/);
  });
});
