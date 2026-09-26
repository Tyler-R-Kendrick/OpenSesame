/**
 * Settings › Notifications as a model, ported from
 * `apps/ceremonies/src/pages/NotificationSettings.test.tsx`: the honesty
 * surface, ordering and fan-out, a refused save, and destinations.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { ASSURANCE_NOTE, channelRow, readChannels } from "./channels.js";
import {
  addableChannels,
  connectableChannels,
  createNotificationRouting,
} from "./routing.js";
import type { RoutingTransport } from "./transport.js";

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** What the server says about a channel; its capabilities are ignored. */
function listed(kind: string, configured: boolean) {
  return {
    kind,
    configured,
    // A server overstating a chat channel must change nothing.
    canSatisfyPhishingResistance: true,
    maximumInteractionMode: "interactive",
  };
}

const CHANNELS = [
  listed("in_app", true),
  listed("telegram", true),
  listed("slack", false),
  listed("native_push", true),
];

const BINDINGS = [
  {
    id: "bind_1",
    kind: "telegram",
    providerId: "telegram",
    displayLabel: "Personal phone",
    state: "active",
    verification: "provider_callback_challenge",
    createdAt: "2026-01-01T00:00:00.000Z",
    providerSubjectId: "tg-77771111",
  },
  {
    id: "bind_2",
    kind: "slack",
    providerId: "slack",
    displayLabel: "Work",
    state: "pending",
    verification: "provider_oauth_install",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const PREFERENCES = {
  byClass: {
    authorization_request: { channels: ["telegram", "in_app"], fanOut: false },
    security_event: { channels: ["in_app"], fanOut: false },
  },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ROUTE = {
  steps: [
    { kind: "telegram", mode: "rendezvous", confidentiality: "minimal" },
    { kind: "in_app", mode: "interactive", confidentiality: "full" },
  ],
  fanOut: false,
  excluded: [
    { kind: "slack", reason: "adapter_unavailable" },
    { kind: "sms", reason: "no_active_binding" },
    { kind: "webhook", reason: "not_allowed_by_policy" },
    // Allowed and unlisted: the server names every channel policy allows.
    { kind: "native_push", reason: "not_preferred" },
  ],
};

/** Answer by path and method; a refused save when `saveStatus` says so. */
function fake(options: { saveStatus?: number; signedIn?: boolean } = {}) {
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    if (path.startsWith("/v1/notification-preferences/effective")) {
      return json(ROUTE);
    }
    if (path === "/v1/notification-preferences") {
      if (method === "PUT" && (options.saveStatus ?? 200) !== 200) {
        return json({ error: "nope" }, options.saveStatus);
      }
      return json(PREFERENCES);
    }
    if (path === "/v1/notification-channels/bindings" && method === "POST") {
      return json(
        { challengeId: "chbc_1", nonce: "n0nce-once", expiresAt: "x" },
        201,
      );
    }
    if (path.startsWith("/v1/notification-channels/bindings/")) {
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/notification-channels/bindings") {
      return json({ bindings: BINDINGS });
    }
    if (path === "/v1/notification-channels")
      return json({ channels: CHANNELS });
    return json({ error: "not_found" }, 404);
  });
  const transport: RoutingTransport = {
    fetch,
    signedIn: () => options.signedIn !== false,
  };
  return { fetch, routing: createNotificationRouting(transport) };
}

function writes(fetch: ReturnType<typeof fake>["fetch"]) {
  return fetch.mock.calls.filter(
    ([path, init]) =>
      path === "/v1/notification-preferences" && init.method === "PUT",
  );
}

describe("notification routing — the honesty surface", () => {
  it("carries the standing note that a channel choice does not lower approval security", () => {
    expect(ASSURANCE_NOTE).toMatch(
      /^Choosing where you're notified doesn't change what it takes to approve/,
    );
    expect(ASSURANCE_NOTE).toContain(
      "High-risk requests always come back here for a passkey",
    );
  });

  it("reads capability from os-domain, never from the server", () => {
    const [, telegram] = readChannels({ channels: CHANNELS });
    expect(telegram?.capabilities.canSatisfyPhishingResistance).toBe(false);
    expect(telegram?.sentence).toMatch(
      /can never approve a high-risk request on its own/,
    );
    expect(channelRow("in_app", false).configured).toBe(true);
  });

  it("reads an unconfigured channel as unconfigured, and never offers it", async () => {
    const { routing } = fake();
    const step = await routing.load();

    const slack = step.state.channels.find((row) => row.kind === "slack");
    expect(slack?.sentence).toBe(
      "Not set up on this deployment — nothing would arrive here.",
    );
    const connectable = connectableChannels(step.state).map((row) => row.kind);
    // No Slack: unconfigured. No push: it binds no provider subject.
    expect(connectable).toEqual(["telegram"]);
    const addable = addableChannels(step.state, "authorization_request");
    expect(addable.map((row) => row.kind)).toEqual(["native_push"]);
  });

  it("puts the effective route in words, every exclusion spelled out", async () => {
    const { routing } = fake();
    const { state } = await routing.load();

    const why = state.route?.excluded.map((entry) => entry.why).join(" ") ?? "";
    expect(why).toMatch(/no working adapter for this channel/);
    expect(why).toMatch(/have not connected a destination for this yet/);
    expect(why).toMatch(/policy does not allow this kind of prompt to go here/);
    expect(state.route?.steps[0]).toMatchObject({
      name: "Telegram",
      sentence:
        "can tell you, and link you back here to decide, and shows nothing about what was asked.",
    });
    const seen = JSON.stringify(state);
    expect(seen).not.toMatch(
      /adapter_unavailable|no_active_binding|not_allowed_by_policy/,
    );
  });

  it("words binding states, and never keeps a provider subject", async () => {
    const { routing } = fake();
    const { state } = await routing.load();

    expect(state.bindings.map((row) => row.stateSentence)).toEqual([
      "Active",
      "Waiting to be confirmed — nothing is delivered here yet",
    ]);
    expect(state.bindings[0]?.label).toBe("Personal phone");
    expect(JSON.stringify(state)).not.toContain("tg-77771111");
  });

  it("asks for a sign-in without fetching anything", async () => {
    const { routing, fetch } = fake({ signedIn: false });
    const step = await routing.load();
    expect(step.error).toMatch(/Sign in/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("notification routing — ordering and fan-out", () => {
  it("reorders a class and saves", async () => {
    const { routing, fetch } = fake();
    await routing.load();

    const step = await routing.edit({
      kind: "move",
      cls: "authorization_request",
      index: 0,
      direction: 1,
    });

    expect(step.status).toBe("Order saved.");
    const [call] = writes(fetch);
    expect(
      JSON.parse(String(call?.[1].body)).byClass.authorization_request.channels,
    ).toEqual(["in_app", "telegram"]);
    expect(step.state.document.byClass.authorization_request?.channels[0]).toBe(
      "in_app",
    );
  });

  it("saves the fan-out toggle for security events", async () => {
    const { routing, fetch } = fake();
    await routing.load();

    const step = await routing.edit({
      kind: "fanOut",
      cls: "security_event",
      fanOut: true,
    });

    expect(step.status).toMatch(/Security events will go to every destination/);
    const body = JSON.parse(String(writes(fetch).at(-1)?.[1].body));
    expect(body.byClass.security_event.fanOut).toBe(true);
  });

  it("keeps the model truthful when a save is refused", async () => {
    const { routing } = fake({ saveStatus: 500 });
    await routing.load();

    const step = await routing.edit({
      kind: "move",
      cls: "authorization_request",
      index: 0,
      direction: 1,
    });

    expect(step.error).toMatch(/did not go through \(500\)\. Nothing changed/);
    expect(step.status).toBeNull();
    // The order stayed where the server has it.
    expect(step.state.document.byClass.authorization_request?.channels).toEqual(
      ["telegram", "in_app"],
    );
  });

  it("saves nothing when an edit changes nothing", async () => {
    const { routing, fetch } = fake();
    await routing.load();
    await routing.edit({
      kind: "remove",
      cls: "security_event",
      channel: "in_app",
    });
    expect(writes(fetch)).toHaveLength(0);
  });
});

describe("notification routing — destinations", () => {
  it("begins a binding, hands the one-time value over once, and keeps it nowhere", async () => {
    const { routing, fetch } = fake();
    await routing.load();

    const step = await routing.bind("telegram");

    expect(step.begun?.nonce).toBe("n0nce-once");
    expect(step.status).toMatch(/Telegram is waiting to be confirmed/);
    expect(JSON.stringify(routing.state())).not.toContain("n0nce-once");
    const post = fetch.mock.calls.find(([, init]) => init.method === "POST");
    expect(JSON.parse(String(post?.[1].body))).toEqual({
      kind: "telegram",
      displayLabel: "Telegram",
    });
  });

  it("refuses a channel with nothing to bind, or no adapter, before any call", async () => {
    const { routing, fetch } = fake();
    await routing.load();
    const before = fetch.mock.calls.length;

    expect((await routing.bind("native_push")).error).toMatch(
      /nothing to connect/,
    );
    expect((await routing.bind("slack")).error).toMatch(/no working adapter/);
    expect(fetch.mock.calls.length).toBe(before);
  });

  it("disconnects a destination and says what that stops", async () => {
    const { routing, fetch } = fake();
    await routing.load();

    const step = await routing.unbind("bind_1");

    expect(step.status).toBe(
      "Disconnected. Nothing else will be delivered to that Telegram destination.",
    );
    expect(
      fetch.mock.calls.some(
        ([path, init]) =>
          path === "/v1/notification-channels/bindings/bind_1" &&
          init.method === "DELETE",
      ),
    ).toBe(true);
  });
});
