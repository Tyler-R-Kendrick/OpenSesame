import { afterEach, describe, expect, it } from "vitest";
import { createBridgeClient } from "./connector-bridge-client.js";
import { fakeBridge } from "./connector-bridge.test-support.js";
import { NativeApiError } from "./native-api-http.js";
import {
  askBridgeFor,
  bindNativeBridge,
  bridgeAdmits,
  bridgeCarries,
  bridgeEligible,
  bridgeGuidance,
  bridgeHostsFor,
  bridgedFetch,
  nativeBridgeStore,
  refreshNativeBridge,
  resetNativeBridgeForTest,
} from "./native-bridge.js";
import { nativeBrowserMethodPolicy } from "./native-browser-policy.js";

afterEach(() => resetNativeBridgeForTest());

function bind(options: Parameters<typeof fakeBridge>[0] = {}) {
  const fake = fakeBridge(options);
  const client = createBridgeClient(fake.channel, { helloMs: 30 });
  const release = bindNativeBridge(client);
  return { fake, client, release };
}

describe("the table's providers", () => {
  it("names the hosts a provider is called at, by the id the app was asked for or its catalog id", () => {
    expect(bridgeHostsFor("plivo")).toEqual(["api.plivo.com"]);
    expect(bridgeEligible("plivo")).toBe(true);
    expect(bridgeEligible("anthropic")).toBe(false);
    expect(bridgeHostsFor("no-such-provider")).toEqual([]);
  });
});

describe("whether a bridge is there", () => {
  it("is absent until one answers, and then holds the hosts a person allowed", async () => {
    expect(nativeBridgeStore.getSnapshot().present).toBe(false);
    bind({ granted: ["api.plivo.com"] });
    expect(nativeBridgeStore.getSnapshot().present).toBe(false);
    await refreshNativeBridge();
    expect(nativeBridgeStore.getSnapshot()).toEqual({
      present: true,
      version: "0.1.0",
      granted: ["api.plivo.com"],
    });
    expect(bridgeAdmits("plivo")).toBe(true);
    expect(bridgeAdmits("sendgrid")).toBe(false);
  });

  it("is absent when nothing answers", async () => {
    bind({ silent: true });
    await refreshNativeBridge();
    expect(nativeBridgeStore.getSnapshot().present).toBe(false);
    expect(bridgeAdmits("plivo")).toBe(false);
  });

  it("tells subscribers once per change, and not when nothing changed", async () => {
    let calls = 0;
    nativeBridgeStore.subscribe(() => {
      calls += 1;
    });
    bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    await refreshNativeBridge();
    expect(calls).toBe(1);
  });

  it("is not told it is absent by an older question that timed out after a newer one found it", async () => {
    // The first hello goes unanswered (the extension was not there yet); the
    // second is answered. The first one's silence arrives last.
    const fake = fakeBridge({ granted: ["api.plivo.com"] });
    let posted = 0;
    const client = createBridgeClient(
      {
        listen: fake.channel.listen,
        post(message) {
          posted += 1;
          if (posted > 1) fake.channel.post(message);
        },
      },
      { helloMs: 40 },
    );
    bindNativeBridge(client);
    const first = refreshNativeBridge();
    const second = refreshNativeBridge();
    await Promise.all([first, second]);
    expect(nativeBridgeStore.getSnapshot().present).toBe(true);
  });

  it("is absent again when the shell lets go of the client", async () => {
    const { release } = bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    release();
    expect(nativeBridgeStore.getSnapshot().present).toBe(false);
  });
});

describe("what a person has left to do", () => {
  it("says to install it when absent, to allow the host when it is there without it, and nothing when ready", async () => {
    expect(bridgeGuidance("plivo")).toEqual({
      state: "absent",
      hosts: ["api.plivo.com"],
    });
    expect(bridgeGuidance("anthropic")).toBeNull();
    bind({ granted: [] });
    await refreshNativeBridge();
    expect(bridgeGuidance("plivo")).toEqual({
      state: "needs-host",
      hosts: ["api.plivo.com"],
    });
    resetNativeBridgeForTest();
    bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    expect(bridgeGuidance("plivo")).toBeNull();
  });

  it("puts the provider's hosts in the bridge's popup, and only when a bridge is there", async () => {
    const absent = bind({ silent: true });
    await askBridgeFor("plivo");
    expect(
      absent.fake.heard.filter((request) => request.op === "need"),
    ).toEqual([]);
    resetNativeBridgeForTest();
    const present = bind({ granted: [] });
    await refreshNativeBridge();
    await askBridgeFor("plivo");
    expect(present.fake.heard.at(-1)).toMatchObject({
      op: "need",
      hosts: ["api.plivo.com"],
    });
  });
});

describe("browser admission", () => {
  it("keeps API setup available independently of optional bridge host grants", async () => {
    expect(nativeBrowserMethodPolicy("plivo", "api-key").available).toBe(true);
    expect(nativeBrowserMethodPolicy("sendgrid", "api-key").available).toBe(
      true,
    );
    bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    const admitted = nativeBrowserMethodPolicy("plivo", "api-key");
    expect(admitted).toMatchObject({ available: true, reason: null });
    expect(admitted.advice).toBeTruthy();
    expect(admitted.evidenceUrls.length).toBeGreaterThan(0);
    // Direct setup does not claim this optional bridge carries an ungranted host.
    expect(nativeBrowserMethodPolicy("sendgrid", "api-key").available).toBe(
      true,
    );
  });

  it("does not lift a refusal for another method", async () => {
    bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    expect(nativeBrowserMethodPolicy("zapier", "mcp").available).toBe(false);
  });

  it("retains documented API advice independently of optional bridge availability", async () => {
    const refused = nativeBrowserMethodPolicy("stepfun", "api-key");
    expect(refused.available).toBe(true);
    expect(refused.advice).toBeTruthy();
    expect(refused.reason).toBeNull();
    expect(refused.evidenceUrls.length).toBeGreaterThan(0);
    bind({ granted: ["api.stepfun.ai"] });
    await refreshNativeBridge();
    expect(nativeBrowserMethodPolicy("stepfun", "api-key").available).toBe(
      true,
    );
  });

  it("leaves a provider that answers a browser as it was", () => {
    expect(nativeBrowserMethodPolicy("anthropic", "api-key").available).toBe(
      true,
    );
  });
});

describe("a registered OAuth application (ADR 0218)", () => {
  it("is carried at the hosts a page cannot read, and its token host is among them", () => {
    expect(bridgeHostsFor("zoom")).toEqual(["api.zoom.us", "zoom.us"]);
    expect(bridgeHostsFor("hubspot")).toContain("api.hubapi.com");
    // Asana answers a web page: the bridge has nothing to carry for it.
    expect(bridgeHostsFor("asana")).toEqual([]);
  });

  it("carries a token exchange to a host the bridge holds, as a form post", async () => {
    const { fake } = bind({
      granted: ["zoom.us"],
      onFetch: () => ({
        status: 200,
        headers: [["content-type", "application/json"]],
        body: '{"access_token":"t","token_type":"bearer","expires_in":3600}',
      }),
    });
    await refreshNativeBridge();
    const response = await bridgedFetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic cHJvYmU6cHJvYmU=",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "c",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ access_token: "t" });
    expect(fake.heard.at(-1)).toMatchObject({
      op: "fetch",
      request: {
        providerId: "zoom",
        url: "https://zoom.us/oauth/token",
        method: "POST",
        body: "grant_type=authorization_code&code=c",
      },
    });
  });

  it("carries a person's own tenant only once they have allowed that host, and asks for it only for the provider that owns the family", async () => {
    const present = bind({ granted: [] });
    await refreshNativeBridge();
    await askBridgeFor("okta", [
      "acme.okta.com",
      "evil.test",
      "acme.myshopify.com",
    ]);
    expect(present.fake.heard.at(-1)).toMatchObject({
      op: "need",
      hosts: ["acme.okta.com"],
    });
    expect(
      bridgeCarries(new URL("https://acme.okta.com/oauth2/v1/token")),
    ).toBeNull();
    resetNativeBridgeForTest();
    bind({ granted: ["acme.okta.com"] });
    await refreshNativeBridge();
    expect(
      bridgeCarries(new URL("https://acme.okta.com/oauth2/v1/token")),
    ).toBe("okta");
    expect(bridgeCarries(new URL("https://other.okta.com/"))).toBeNull();
  });
});

describe("carrying a request", () => {
  it("sends only to a host the bridge holds", async () => {
    bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    expect(bridgeCarries(new URL("https://api.plivo.com/v1/"))).toBe("plivo");
    expect(bridgeCarries(new URL("https://api.sendgrid.com/v3/"))).toBeNull();
    expect(bridgeCarries(new URL("https://evil.test/"))).toBeNull();
  });

  it("answers as the Response a direct call would have given", async () => {
    const { fake } = bind({
      granted: ["api.plivo.com"],
      onFetch: () => ({
        status: 401,
        headers: [["content-type", "application/json"]],
        body: '{"error":"unauthorized"}',
      }),
    });
    await refreshNativeBridge();
    const response = await bridgedFetch("https://api.plivo.com/v1/Account/x/", {
      method: "get",
      headers: { Authorization: "Basic abc", Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    const sent = fake.heard.at(-1);
    expect(sent).toMatchObject({
      op: "fetch",
      request: {
        providerId: "plivo",
        url: "https://api.plivo.com/v1/Account/x/",
        method: "GET",
        body: null,
      },
    });
    if (sent?.op === "fetch")
      expect(sent.request.headers).toEqual(
        expect.arrayContaining([
          ["authorization", "Basic abc"],
          ["accept", "application/json"],
        ]),
      );
  });

  it("carries a text body, and a form body as text", async () => {
    const { fake } = bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    await bridgedFetch("https://api.plivo.com/v1/x", {
      method: "POST",
      body: '{"a":1}',
    });
    await bridgedFetch("https://api.plivo.com/v1/x", {
      method: "POST",
      body: new URLSearchParams({ a: "1" }),
    });
    const bodies = fake.heard.flatMap((request) =>
      request.op === "fetch" ? [request.request.body] : [],
    );
    expect(bodies).toEqual(['{"a":1}', "a=1"]);
  });

  it.each([
    [
      "a body the bridge cannot carry",
      { method: "POST", body: new Blob(["x"]) },
    ],
    ["a method the bridge does not carry", { method: "TRACE" }],
  ])("refuses %s, and sends nothing", async (_name, init) => {
    const { fake } = bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    const before = fake.heard.length;
    await expect(
      bridgedFetch("https://api.plivo.com/v1/x", init),
    ).rejects.toBeInstanceOf(NativeApiError);
    expect(fake.heard.length).toBe(before);
  });

  it("refuses a request for a host it does not hold, as a bridge failure rather than a network one", async () => {
    bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    await expect(
      bridgedFetch("https://api.sendgrid.com/v3/x"),
    ).rejects.toMatchObject({ code: "bridge" });
  });

  it("gives the bridge's refusal as an error a connection knows how to show, and a failed request as a network one", async () => {
    const refusing = bind({
      granted: ["api.plivo.com"],
      onFetch: () => ({ error: "not_granted" }),
    });
    await refreshNativeBridge();
    await expect(
      bridgedFetch("https://api.plivo.com/v1/x"),
    ).rejects.toMatchObject({ code: "bridge" });
    refusing.release();
    resetNativeBridgeForTest();
    bind({ granted: ["api.plivo.com"], onFetch: () => ({ error: "network" }) });
    await refreshNativeBridge();
    await expect(
      bridgedFetch("https://api.plivo.com/v1/x"),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("does not send a request already aborted", async () => {
    const { fake } = bind({ granted: ["api.plivo.com"] });
    await refreshNativeBridge();
    const controller = new AbortController();
    controller.abort();
    const before = fake.heard.length;
    await expect(
      bridgedFetch("https://api.plivo.com/v1/x", { signal: controller.signal }),
    ).rejects.toBeTruthy();
    expect(fake.heard.length).toBe(before);
  });

  it("returns no body for a 204", async () => {
    bind({
      granted: ["api.plivo.com"],
      onFetch: () => ({ status: 204, headers: [], body: "" }),
    });
    await refreshNativeBridge();
    const response = await bridgedFetch("https://api.plivo.com/v1/x", {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});
