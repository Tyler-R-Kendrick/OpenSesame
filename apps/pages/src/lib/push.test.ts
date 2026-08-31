/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PushError,
  disablePush,
  enablePush,
  pushNotificationBody,
  pushSeams,
  pushSupported,
  reviewUrlFromPayload,
} from "./push.js";

const here = dirname(fileURLToPath(import.meta.url));

const fetchFn = vi.hoisted(() => vi.fn());

const defaults = {
  fetchFn: pushSeams.fetchFn,
  serviceWorkerContainer: pushSeams.serviceWorkerContainer,
  pushApiAvailable: pushSeams.pushApiAvailable,
  requestPermission: pushSeams.requestPermission,
};

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

beforeEach(() => {
  fetchFn.mockReset();
  Object.assign(pushSeams, {
    fetchFn,
    pushApiAvailable: () => true,
    requestPermission: async () => "granted",
  });
});

afterEach(() => {
  Object.assign(pushSeams, defaults);
});

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

describe("the service worker's own listeners", () => {
  const sw = readFileSync(join(here, "../sw.ts"), "utf8");
  // Comments explain what must not happen and therefore name it; the sweep is
  // about what the worker actually executes.
  const code = sw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

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
      expect(sw).toContain(`sw.addEventListener("${listener}"`);
    }
    expect(sw).toContain('const CACHE = "opensesame-pages-v3"');
  });
});

/* ------------------------------------------------------------------ *
 * Enrolment
 * ------------------------------------------------------------------ */

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function worker(subscription: BoundaryValue, subscribe = vi.fn()) {
  const getSubscription = vi.fn(async () => subscription);
  const registration = {
    pushManager: { getSubscription, subscribe },
  };
  Object.assign(pushSeams, {
    serviceWorkerContainer: () => ({ ready: Promise.resolve(registration) }),
  });
  return { getSubscription, subscribe };
}

const SUBSCRIPTION = {
  endpoint: "https://push.example/endpoint/abc",
  toJSON: () => ({
    endpoint: "https://push.example/endpoint/abc",
    keys: { p256dh: "cDI1NmRo", auth: "YXV0aA" },
  }),
  unsubscribe: vi.fn(async () => true),
};

describe("enrolment", () => {
  it("reports no support rather than pretending", async () => {
    Object.assign(pushSeams, {
      serviceWorkerContainer: () => null,
      pushApiAvailable: () => false,
    });
    expect(pushSupported()).toBe(false);
    await expect(
      enablePush({ baseUrl: "https://id.example", accessToken: "t" }),
    ).rejects.toBeInstanceOf(PushError);
  });

  it("refuses when notifications are blocked, and says requests still wait", async () => {
    worker(null);
    Object.assign(pushSeams, { requestPermission: async () => "denied" });
    await expect(
      enablePush({ baseUrl: "https://id.example", accessToken: "t" }),
    ).rejects.toThrow(/still wait for you in the app/);
  });

  it("fetches the VAPID key, subscribes user-visibly, and registers", async () => {
    const asked: PushSubscriptionOptionsInit[] = [];
    const subscribe = vi.fn(async (options: PushSubscriptionOptionsInit) => {
      asked.push(options);
      return SUBSCRIPTION;
    });
    worker(null, subscribe);
    fetchFn.mockResolvedValueOnce(json({ publicKey: "cHVibGlja2V5" }));
    fetchFn.mockResolvedValueOnce(
      json({ id: "push_1", createdAt: "2026-01-01T00:00:00.000Z" }),
    );

    const record = await enablePush({
      baseUrl: "https://id.example/",
      accessToken: "session-bearer",
      deviceLabel: "Laptop",
    });
    expect(record.id).toBe("push_1");

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "https://id.example/v1/notification-channels/push/key",
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.userVisibleOnly).toBe(true);
    expect(asked[0]?.applicationServerKey).toBeTruthy();

    const init: RequestInit = fetchFn.mock.calls[1]?.[1] ?? {};
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      "https://id.example/v1/notification-channels/push/subscriptions",
    );
    expect(JSON.parse(String(init.body ?? "{}"))).toEqual({
      endpoint: "https://push.example/endpoint/abc",
      keys: { p256dh: "cDI1NmRo", auth: "YXV0aA" },
      deviceLabel: "Laptop",
    });
  });

  it("reuses an existing subscription instead of minting a second", async () => {
    const subscribe = vi.fn();
    worker(SUBSCRIPTION, subscribe);
    fetchFn.mockResolvedValueOnce(json({ id: "push_1", createdAt: "x" }));

    await enablePush({ baseUrl: "https://id.example", accessToken: "t" });
    expect(subscribe).not.toHaveBeenCalled();
    // No key fetch either: nothing new is being signed for.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("withdraws by opaque id, never by the capability endpoint", async () => {
    const unsubscribe = vi.fn(async () => true);
    worker({ ...SUBSCRIPTION, unsubscribe });
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 204 }));

    expect(
      await disablePush({
        baseUrl: "https://id.example",
        accessToken: "t",
        subscriptionId: "push_1",
      }),
    ).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://id.example/v1/notification-channels/push/subscriptions/push_1",
    );
    expect(init?.method).toBe("DELETE");
    // The endpoint is a capability URL: it is never sent back to be matched on.
    expect(String(url)).not.toContain("push.example");
    expect(String(init?.body ?? "")).not.toContain("push.example");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("treats an already-forgotten subscription as the outcome it wanted", async () => {
    const unsubscribe = vi.fn(async () => true);
    worker({ ...SUBSCRIPTION, unsubscribe });
    fetchFn.mockResolvedValueOnce(json({ error: "not_found" }, 404));

    expect(
      await disablePush({
        baseUrl: "https://id.example",
        accessToken: "t",
        subscriptionId: "push_gone",
      }),
    ).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("stops delivering locally even when the server call fails", async () => {
    const unsubscribe = vi.fn(async () => true);
    worker({ ...SUBSCRIPTION, unsubscribe });
    fetchFn.mockResolvedValueOnce(json({ error: "boom" }, 500));

    await expect(
      disablePush({
        baseUrl: "https://id.example",
        accessToken: "t",
        subscriptionId: "push_1",
      }),
    ).rejects.toBeInstanceOf(PushError);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("undoes the browser half even with no id to name on the server", async () => {
    const unsubscribe = vi.fn(async () => true);
    worker({ ...SUBSCRIPTION, unsubscribe });

    expect(
      await disablePush({ baseUrl: "https://id.example", accessToken: "t" }),
    ).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when nothing was subscribed here", async () => {
    worker(null);
    expect(
      await disablePush({ baseUrl: "https://id.example", accessToken: "t" }),
    ).toBe(false);
  });
});
