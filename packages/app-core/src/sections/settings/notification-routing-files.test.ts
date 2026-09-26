/**
 * Settings › Notifications as files (ADR 0134): the routing document is a
 * file the Form and the viewer both write through one road, and the file can
 * no more widen a preference than the Form can (ADR 0084).
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import {
  type RoutingState,
  createNotificationRouting,
} from "../../lib/notification-routing/routing.js";
import type { RoutingTransport } from "../../lib/notification-routing/transport.js";
import {
  BINDINGS_FILE,
  CHANNELS_FILE,
  ROUTING_FILE,
  notificationRoutingFiles,
} from "./notification-routing-files.js";

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ROUTE = {
  steps: [{ kind: "in_app", mode: "interactive", confidentiality: "full" }],
  fanOut: false,
  excluded: [
    { kind: "telegram", reason: "not_preferred" },
    { kind: "slack", reason: "not_allowed_by_policy" },
  ],
};

function setup() {
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const url = new URL(path, "https://id.example");
    if (url.pathname === "/v1/notification-preferences/effective") {
      return json(ROUTE);
    }
    if (url.pathname === "/v1/notification-preferences") {
      return json({
        byClass: {
          security_event: { channels: ["in_app"], fanOut: true },
        },
      });
    }
    if (url.pathname === "/v1/notification-channels/bindings") {
      return json({
        bindings: [
          {
            id: "bind_1",
            kind: "telegram",
            displayLabel: "Personal phone",
            state: "active",
            providerSubjectId: "tg-77771111",
            providerTenantId: "bot-1",
          },
        ],
      });
    }
    if (url.pathname === "/v1/notification-channels") {
      return json({
        channels: [
          { kind: "in_app", configured: true },
          { kind: "telegram", configured: true },
          { kind: "slack", configured: true },
        ],
      });
    }
    return json({ error: "not_found", method: init.method }, 404);
  });
  const transport: RoutingTransport = { fetch, signedIn: () => true };
  const routing = createNotificationRouting(transport);
  let state: RoutingState | null = null;
  const files = notificationRoutingFiles({
    current: () => state,
    replace: async (document) => {
      const step = await routing.replace(document);
      state = step.state;
      return step;
    },
  });
  return {
    fetch,
    files,
    load: async () => {
      state = (await routing.load()).state;
    },
  };
}

const puts = (fetch: ReturnType<typeof setup>["fetch"]) =>
  fetch.mock.calls.filter(([, init]) => init.method === "PUT");

describe("Settings › Notifications files", () => {
  it("lists nothing until the preferences have been read", async () => {
    const { files, load } = setup();
    expect(files.list()).toEqual([]);
    await load();
    expect(files.list().map((file) => [file.path, file.readOnly])).toEqual([
      [ROUTING_FILE, false],
      [CHANNELS_FILE, true],
      [BINDINGS_FILE, true],
    ]);
  });

  it("reads the routing document as the Identity API holds it", async () => {
    const { files, load } = setup();
    await load();
    expect(JSON.parse(await files.read(ROUTING_FILE))).toEqual({
      version: 1,
      byClass: { security_event: { channels: ["in_app"], fanOut: true } },
    });
  });

  it("reads channels from os-domain, and bindings without a provider subject", async () => {
    const { files, load } = setup();
    await load();
    const channels = JSON.parse(await files.read(CHANNELS_FILE));
    expect(channels.channels[1]).toEqual({
      kind: "telegram",
      configured: true,
      interaction: "interactive",
      shows: "descriptive",
      canApproveHighRisk: false,
    });
    const bindings = await files.read(BINDINGS_FILE);
    expect(JSON.parse(bindings).bindings).toEqual([
      {
        id: "bind_1",
        kind: "telegram",
        label: "Personal phone",
        state: "active",
      },
    ]);
    expect(bindings).not.toContain("tg-77771111");
    expect(bindings).not.toContain("bot-1");
  });

  it("refuses a file that says what it takes to approve, and sends nothing", async () => {
    const { files, fetch, load } = setup();
    await load();
    const widened = JSON.stringify({
      version: 1,
      byClass: {},
      requiredAssurance: "aal1",
    });
    const check = files.check(ROUTING_FILE, widened);
    expect(check).toEqual({
      ok: false,
      message:
        "document.requiredAssurance cannot set what it takes to approve — a preference only orders where you are told.",
    });
    expect((await files.write(ROUTING_FILE, widened)).ok).toBe(false);
    expect(puts(fetch)).toHaveLength(0);
  });

  it("refuses a file that adds a channel policy refused, and sends nothing", async () => {
    const { files, fetch, load } = setup();
    await load();
    const admitted = JSON.stringify({
      version: 1,
      byClass: {
        authorization_request: { channels: ["slack", "in_app"], fanOut: false },
      },
    });
    const outcome = await files.write(ROUTING_FILE, admitted);
    expect(outcome).toEqual({
      ok: false,
      message: `Your operator's policy does not allow Slack for "Someone asks to use your authority". A preference can reorder and narrow what policy allows; it cannot add to it.`,
    });
    expect(puts(fetch)).toHaveLength(0);
  });

  it("saves a narrowing through the Identity API and reads it back", async () => {
    const { files, fetch, load } = setup();
    await load();
    const narrowed = JSON.stringify({
      version: 1,
      byClass: {
        authorization_request: {
          channels: ["telegram", "in_app"],
          fanOut: false,
        },
      },
    });
    expect(await files.write(ROUTING_FILE, narrowed)).toEqual({
      ok: true,
      path: ROUTING_FILE,
    });
    const [put] = puts(fetch);
    expect(JSON.parse(String(put?.[1].body))).toEqual({
      byClass: {
        authorization_request: {
          channels: ["telegram", "in_app"],
          fanOut: false,
        },
      },
    });
    expect(await files.read(ROUTING_FILE)).toContain('"telegram"');
  });

  it("writes and removes nothing but the routing document", async () => {
    const { files, load } = setup();
    await load();
    expect((await files.write(BINDINGS_FILE, "{}")).ok).toBe(false);
    expect(files.check(CHANNELS_FILE, "{}").ok).toBe(false);
    expect((await files.remove(ROUTING_FILE)).ok).toBe(false);
    expect(files.check(ROUTING_FILE, "not json")).toEqual({
      ok: false,
      message: "routing.json is not valid JSON.",
    });
  });
});
