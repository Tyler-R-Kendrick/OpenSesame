/**
 * A preference reorders and narrows what policy allows; it never admits a
 * channel policy refused (ADR 0084 §3). The route per class is the server's,
 * and the refusal happens before anything is sent.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { readEffectiveRoute } from "./channels.js";
import { addChannel, emptyRoutingDocument } from "./document.js";
import { admitsRefusedChannel, policyAllows } from "./policy.js";
import { addableChannels, createNotificationRouting } from "./routing.js";
import type { RoutingTransport } from "./transport.js";

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Push is allowed for security events, refused for authorization requests. */
const ROUTES = {
  authorization_request: {
    steps: [{ kind: "in_app", mode: "interactive", confidentiality: "full" }],
    fanOut: false,
    excluded: [{ kind: "telegram", reason: "not_preferred" }],
  },
  authorization_decision: {
    steps: [{ kind: "in_app", mode: "interactive", confidentiality: "full" }],
    fanOut: false,
    excluded: [],
  },
  security_event: {
    steps: [{ kind: "in_app", mode: "interactive", confidentiality: "full" }],
    fanOut: false,
    excluded: [
      { kind: "native_push", reason: "not_preferred" },
      { kind: "telegram", reason: "not_preferred" },
    ],
  },
} satisfies Record<string, BoundaryValue>;

function routeFor(cls: string | null): BoundaryValue {
  return Object.entries(ROUTES).find(([key]) => key === cls)?.[1] ?? {};
}

function fake() {
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const url = new URL(path, "https://id.example");
    if (url.pathname === "/v1/notification-preferences/effective") {
      return json(routeFor(url.searchParams.get("class")));
    }
    if (url.pathname === "/v1/notification-preferences") {
      return json({ byClass: {} });
    }
    if (url.pathname === "/v1/notification-channels/bindings") {
      return json({ bindings: [] });
    }
    if (url.pathname === "/v1/notification-channels") {
      return json({
        channels: [
          { kind: "in_app", configured: true },
          { kind: "native_push", configured: true },
          { kind: "telegram", configured: true },
        ],
      });
    }
    return json({ error: "not_found", method: init.method ?? "GET" }, 404);
  });
  const transport: RoutingTransport = { fetch, signedIn: () => true };
  return { fetch, routing: createNotificationRouting(transport) };
}

function puts(fetch: ReturnType<typeof fake>["fetch"]) {
  return fetch.mock.calls.filter(([, init]) => init.method === "PUT");
}

describe("notification routing — policy only narrows", () => {
  it("reads what policy allows from the route, never a reason code", () => {
    const route = readEffectiveRoute({
      steps: [{ kind: "telegram", mode: "rendezvous" }],
      excluded: [
        { kind: "slack", reason: "adapter_unavailable" },
        { kind: "sms", reason: "not_allowed_by_policy" },
      ],
    });
    expect(route.allowed).toEqual(["in_app", "telegram", "slack"]);
    expect(policyAllows(route, "sms")).toBe(false);
    expect(policyAllows(route, "in_app")).toBe(true);
    expect(policyAllows(undefined, "sms")).toBeNull();
    expect(route.excluded.map((entry) => entry.refusedByPolicy)).toEqual([
      false,
      true,
    ]);
  });

  it("never offers a channel policy refused for the class", async () => {
    const { routing } = fake();
    const { state } = await routing.load();
    const offered = (cls: "authorization_request" | "security_event") =>
      addableChannels(state, cls).map((row) => row.kind);
    expect(offered("authorization_request")).toEqual(["telegram"]);
    expect(offered("security_event")).toEqual(["native_push", "telegram"]);
  });

  it("refuses an edit that adds a refused channel, before any save", async () => {
    const { routing, fetch } = fake();
    await routing.load();

    const step = await routing.edit({
      kind: "add",
      cls: "authorization_request",
      channel: "native_push",
    });

    expect(step.error).toBe(
      `Your operator's policy does not allow Push notification for "Someone asks to use your authority". A preference can reorder and narrow what policy allows; it cannot add to it.`,
    );
    expect(step.state.document.byClass.authorization_request).toBeUndefined();
    expect(puts(fetch)).toHaveLength(0);
  });

  it("refuses the same document written as a whole file", async () => {
    const { routing, fetch } = fake();
    const { state } = await routing.load();
    const next = addChannel(
      state.document,
      "authorization_request",
      "native_push",
    );

    const step = await routing.replace(next);

    expect(step.error).toMatch(/cannot add to it/);
    expect(puts(fetch)).toHaveLength(0);
  });

  it("saves a channel policy allows, and a narrowing", async () => {
    const { routing, fetch } = fake();
    await routing.load();

    const added = await routing.edit({
      kind: "add",
      cls: "security_event",
      channel: "native_push",
    });
    expect(added.error).toBeNull();
    const removed = await routing.edit({
      kind: "remove",
      cls: "security_event",
      channel: "native_push",
    });
    expect(removed.error).toBeNull();
    expect(puts(fetch)).toHaveLength(2);
  });

  it("keeps a channel listed before policy tightened, and moves it", () => {
    const before = addChannel(
      emptyRoutingDocument(),
      "authorization_request",
      "native_push",
    );
    const routes = {
      authorization_request: readEffectiveRoute(ROUTES.authorization_request),
    };
    expect(admitsRefusedChannel(before, before, routes)).toBeNull();
    const added = addChannel(before, "authorization_request", "telegram");
    expect(admitsRefusedChannel(before, added, routes)).toBeNull();
  });
});
