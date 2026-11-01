import type { BridgeFetchRequest } from "@opensesame/connector-bridge";
import { describe, expect, it } from "vitest";
import { type SenderFacts, createBridge } from "./bridge.js";
import { relayId } from "./sites.js";
import { EXTENSION_ID, fakePorts } from "./test-ports.js";

const APP = "https://opensesame-labs.github.io";
const table = [
  { providerId: "plivo", authorities: ["api.plivo.com"] },
] as const;
const id = "req_0123456789";
const tab: SenderFacts = {
  id: EXTENSION_ID,
  tabId: 7,
  frameId: 0,
  url: `${APP}/OpenSesame/`,
};

async function ready(fetcher?: Parameters<typeof fakePorts>[0]) {
  const fake = fakePorts(fetcher);
  fake.origins.add(APP);
  const bridge = createBridge(fake.ports, table, "0.1.0");
  await bridge.sites.enable(APP);
  return { fake, bridge };
}
const fetchRequest: BridgeFetchRequest = {
  providerId: "plivo",
  url: "https://api.plivo.com/v1/Account/x/",
  method: "GET",
  headers: [["authorization", "Basic abc"]],
  body: null,
};

describe("who the bridge answers", () => {
  it("answers the top frame of a tab at an origin a person switched on", async () => {
    const { bridge } = await ready();
    expect(await bridge.relay({ id, op: "hello" }, tab)).toEqual({
      id,
      result: {
        bridge: "opensesame-connector-bridge",
        version: "0.1.0",
        granted: [],
      },
    });
  });

  it.each([
    ["another extension", { ...tab, id: "someone-else" }],
    ["no id", { ...tab, id: undefined }],
    ["a message with no tab", { ...tab, tabId: undefined }],
    ["a subframe", { ...tab, frameId: 3 }],
    [
      "an origin that was never switched on",
      { ...tab, url: "https://evil.example/" },
    ],
    ["no url", { ...tab, url: undefined }],
    [
      "a plain-http origin",
      { ...tab, url: "http://opensesame-labs.github.io/" },
    ],
  ])("refuses %s", async (_name, sender) => {
    const { bridge, fake } = await ready();
    expect(await bridge.relay({ id, op: "hello" }, sender)).toEqual({
      id,
      error: "not_enabled",
    });
    expect(
      await bridge.relay({ id, op: "fetch", request: fetchRequest }, sender),
    ).toEqual({ id, error: "not_enabled" });
    expect(fake.sent).toEqual([]);
  });

  it("stops answering the moment the grant is taken back in the browser", async () => {
    const { bridge, fake } = await ready();
    fake.origins.delete(APP);
    expect(await bridge.relay({ id, op: "hello" }, tab)).toEqual({
      id,
      error: "not_enabled",
    });
  });

  it("stops answering when the relay registration is gone", async () => {
    const { bridge, fake } = await ready();
    fake.registered.delete(relayId(APP));
    expect(await bridge.relay({ id, op: "hello" }, tab)).toEqual({
      id,
      error: "not_enabled",
    });
  });

  it("tells the popup from a tab by the absence of one", async () => {
    const { bridge } = await ready();
    expect(
      bridge.fromPopup({
        id: EXTENSION_ID,
        tabId: undefined,
        frameId: undefined,
        url: undefined,
      }),
    ).toBe(true);
    expect(bridge.fromPopup(tab)).toBe(false);
    expect(
      bridge.fromPopup({
        id: "other",
        tabId: undefined,
        frameId: undefined,
        url: undefined,
      }),
    ).toBe(false);
  });
});

describe("what a page may ask once admitted", () => {
  it("records an ask for a host without allowing it", async () => {
    const { bridge, fake } = await ready();
    expect(
      await bridge.relay(
        { id, op: "need", hosts: ["api.plivo.com", "evil.test"] },
        tab,
      ),
    ).toEqual({
      id,
      result: { pending: ["api.plivo.com"] },
    });
    expect(fake.state.badge).toBe("1");
    expect(await bridge.hosts.granted()).toEqual([]);
  });

  it("refuses a fetch to a host nobody allowed, and sends nothing", async () => {
    const { bridge, fake } = await ready();
    expect(
      await bridge.relay({ id, op: "fetch", request: fetchRequest }, tab),
    ).toEqual({ id, error: "not_granted" });
    expect(fake.sent).toEqual([]);
  });

  it("has the rule that drops the Origin header in place before the first request to a host", async () => {
    const { bridge, fake } = await ready(async () => new Response("{}"));
    fake.hosts.add("api.plivo.com");
    expect(fake.bare).toEqual([]);
    await bridge.relay({ id, op: "fetch", request: fetchRequest }, tab);
    expect(fake.bare).toEqual(["api.plivo.com"]);
  });

  it("sends a fetch to an allowed host and answers with what came back", async () => {
    const { bridge, fake } = await ready(
      async () =>
        new Response('{"auth_id":"MA1"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    fake.hosts.add("api.plivo.com");
    const reply = await bridge.relay(
      { id, op: "fetch", request: fetchRequest },
      tab,
    );
    expect(reply).toEqual({
      id,
      result: {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: '{"auth_id":"MA1"}',
      },
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.url.href).toBe(fetchRequest.url);
    expect(fake.sent[0]?.init.headers).toEqual([
      ["authorization", "Basic abc"],
    ]);
  });

  const refused: [string, BridgeFetchRequest, string][] = [
    [
      "another provider's host",
      { ...fetchRequest, providerId: "datadog" },
      "host_not_allowed",
    ],
    [
      "a host the table does not name",
      { ...fetchRequest, url: "https://evil.test/" },
      "host_not_allowed",
    ],
    [
      "a cookie header",
      { ...fetchRequest, headers: [["cookie", "a=b"]] },
      "denied_header",
    ],
    ["a body on a GET", { ...fetchRequest, body: "x" }, "bad_request"],
  ];
  it.each(refused)(
    "refuses %s even when the host is allowed",
    async (_name, request, code) => {
      const { bridge, fake } = await ready(async () => new Response("x"));
      fake.hosts.add("api.plivo.com");
      expect(await bridge.relay({ id, op: "fetch", request }, tab)).toEqual({
        id,
        error: code,
      });
      expect(fake.sent).toEqual([]);
    },
  );

  it("answers a failed request with its class, never the provider's words", async () => {
    const { bridge, fake } = await ready(async () => {
      throw new TypeError("net::ERR_NAME_NOT_RESOLVED api.plivo.com");
    });
    fake.hosts.add("api.plivo.com");
    expect(
      await bridge.relay({ id, op: "fetch", request: fetchRequest }, tab),
    ).toEqual({ id, error: "network" });
  });
});
