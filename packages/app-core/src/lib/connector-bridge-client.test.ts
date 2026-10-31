import { describe, expect, it } from "vitest";
import {
  BridgeCallError,
  createBridgeClient,
} from "./connector-bridge-client.js";
import { fakeBridge } from "./connector-bridge.test-support.js";

const request = {
  providerId: "plivo",
  url: "https://api.plivo.com/v1/Account/x/",
  method: "GET" as const,
  headers: [["authorization", "Basic abc"]] satisfies [string, string][],
  body: null,
};

describe("the page's questions to the bridge", () => {
  it("learns who the bridge is and what it holds", async () => {
    const fake = fakeBridge({ granted: ["api.plivo.com"] });
    const client = createBridgeClient(fake.channel);
    expect(await client.hello()).toEqual({
      bridge: "opensesame-connector-bridge",
      version: "0.1.0",
      granted: ["api.plivo.com"],
    });
    client.close();
  });

  it("finds no bridge when nothing answers, and does not wait forever", async () => {
    const fake = fakeBridge({ silent: true });
    const client = createBridgeClient(fake.channel, { helloMs: 20 });
    expect(await client.hello()).toBeNull();
    expect(fake.heard).toHaveLength(1);
    client.close();
  });

  it("sends a request and returns what the provider said", async () => {
    const fake = fakeBridge({
      onFetch: () => ({
        status: 401,
        headers: [["content-type", "application/json"]],
        body: '{"e":1}',
      }),
    });
    const client = createBridgeClient(fake.channel);
    expect(await client.fetch(request)).toEqual({
      status: 401,
      headers: [["content-type", "application/json"]],
      body: '{"e":1}',
    });
    expect(fake.heard[0]).toMatchObject({ op: "fetch", request });
    client.close();
  });

  it("raises the bridge's refusal by its code", async () => {
    const client = createBridgeClient(
      fakeBridge({ onFetch: () => ({ error: "not_granted" }) }).channel,
    );
    await expect(client.fetch(request)).rejects.toMatchObject({
      name: "BridgeCallError",
      code: "not_granted",
    });
    client.close();
  });

  it("raises an unanswered request after its time", async () => {
    const client = createBridgeClient(fakeBridge({ silent: true }).channel, {
      fetchMs: 20,
    });
    await expect(client.fetch(request)).rejects.toBeInstanceOf(BridgeCallError);
    client.close();
  });

  it("passes the hosts a connection needs to the bridge", async () => {
    const fake = fakeBridge();
    const client = createBridgeClient(fake.channel);
    expect(await client.need(["api.plivo.com"])).toEqual(["api.plivo.com"]);
    expect(fake.heard[0]).toMatchObject({
      op: "need",
      hosts: ["api.plivo.com"],
    });
    client.close();
  });

  it("keeps two questions apart, whichever answer comes first", async () => {
    const fake = fakeBridge({
      onFetch: (asked) => ({ status: 200, headers: [], body: asked.url }),
    });
    const client = createBridgeClient(fake.channel);
    const [a, b] = await Promise.all([
      client.fetch({ ...request, url: "https://api.plivo.com/a" }),
      client.fetch({ ...request, url: "https://api.plivo.com/b" }),
    ]);
    expect([a.body, b.body]).toEqual([
      "https://api.plivo.com/a",
      "https://api.plivo.com/b",
    ]);
    client.close();
  });

  it("ignores a message that is not an answer it is waiting for", async () => {
    const fake = fakeBridge({ silent: true });
    const client = createBridgeClient(fake.channel, { helloMs: 30 });
    const pending = client.hello();
    for (const handler of fake.handlers)
      handler({
        channel: "opensesame.connector-bridge",
        version: 1,
        direction: "response",
        id: "someone-else-id",
        ok: false,
        error: "timeout",
      });
    expect(await pending).toBeNull();
    client.close();
  });

  it("stops listening when closed", async () => {
    const fake = fakeBridge();
    const client = createBridgeClient(fake.channel);
    await client.hello();
    expect(fake.handlers.size).toBe(1);
    client.close();
    expect(fake.handlers.size).toBe(0);
  });
});

describe("winding the client down", () => {
  it("still reads an answer to a request already sent, then lets the channel go", async () => {
    const fake = fakeBridge({
      onFetch: () => ({
        status: 200,
        headers: [],
        body: '{"access_token":"t"}',
      }),
    });
    const client = createBridgeClient(fake.channel);
    const sent = client.fetch(request);
    client.drain();
    expect(await sent).toMatchObject({ status: 200 });
    // The channel is released once the last answer has landed.
    expect(fake.handlers.size).toBe(0);
  });

  it("starts nothing new once it is winding down", async () => {
    const fake = fakeBridge();
    const client = createBridgeClient(fake.channel);
    client.drain();
    await expect(client.fetch(request)).rejects.toMatchObject({
      code: "unanswered",
    });
    expect(fake.heard).toHaveLength(0);
  });

  it("close, by contrast, drops what was waiting", async () => {
    const fake = fakeBridge({ silent: true });
    const client = createBridgeClient(fake.channel);
    const sent = client.fetch(request);
    client.close();
    await expect(sent).rejects.toBeInstanceOf(BridgeCallError);
  });
});
