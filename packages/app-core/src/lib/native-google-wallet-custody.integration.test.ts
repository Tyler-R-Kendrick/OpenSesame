import { afterEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { googleWalletTransportFlows } from "./native-google-wallet-transport.js";
import { googleWalletKeyFlows as flows } from "./native-google-wallet.js";
import {
  walletClass,
  walletIssuer,
  walletOracle,
  walletOrigin,
} from "./native-google-wallet.test-support.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
function draft(account: string): NativeApiConfigureInput {
  return {
    providerId: "google-wallet",
    displayName: "Issuer",
    parameters: {
      issuer_id: walletIssuer,
      class_id: walletClass,
      origin: walletOrigin,
    },
    credentials: { service_account_json: account },
  };
}
async function fixture() {
  const store = await runtimeFixture();
  closes.push(() => store.close());
  const o = await walletOracle();
  closes.push(() => o.close());
  const fetch = o.transport.fetch;
  const assertCurrent = o.transport.assertCurrent;
  const transport = { ...o.transport, signal: o.owner.signal };
  transport.fetch = function (input, init) {
    expect(this).toBe(transport);
    return fetch.call(o.transport, input, init);
  };
  transport.assertCurrent = function () {
    expect(this).toBe(transport);
    assertCurrent.call(o.transport);
  };
  return { ...o, store, transport };
}
async function saved() {
  const f = await fixture();
  const view = await flows.configure(draft(f.account), f.transport);
  return {
    ...f,
    view,
    invoke: (input = { title: "Original title", header: "Original header" }) =>
      flows.invoke(
        view.connectionId,
        "provider.pass.prepare",
        input,
        f.transport,
      ),
  };
}
function payload(f: Awaited<ReturnType<typeof fixture>>, url: string) {
  return f.verifySave(url).payload;
}
it("binds both transport methods to their original receiver and signs the independently verified original payload", async () => {
  const f = await saved();
  const result = await f.invoke();
  const url = result.items[0]?.url;
  if (!url) throw new Error("Missing public Save handoff");
  expect(payload(f, url)).toMatchObject({
    genericObjects: [
      {
        classId: walletClass,
        cardTitle: { defaultValue: { value: "Original title" } },
        header: { defaultValue: { value: "Original header" } },
      },
    ],
  });
  expect(f.requests.every((r) => r.authorized)).toBe(true);
  expect(f.store.fetcher).not.toHaveBeenCalled();
});
it.each(["fetch", "assertCurrent", "signal"] as const)(
  "captures %s before configure's first asynchronous fingerprint or proof",
  async (method) => {
    const f = await fixture();
    const replacement = vi.fn<NativeProviderTransport["fetch"]>();
    const pending = flows.configure(draft(f.account), f.transport);
    if (method === "fetch") f.transport.fetch = replacement;
    if (method === "assertCurrent") f.transport.assertCurrent = () => {};
    if (method === "signal") f.transport.signal = new AbortController().signal;
    await expect(pending).rejects.toThrow();
    expect(f.requests).toEqual([]);
    expect(replacement).not.toHaveBeenCalled();
  },
);
it.each(["fetch", "assertCurrent", "signal"] as const)(
  "rejects a held token when the original %s is replaced; never adopts a later route",
  async (method) => {
    const f = await saved();
    const held = f.hold("token");
    const replacement = vi.fn<NativeProviderTransport["fetch"]>();
    const pending = f.invoke();
    const refused = expect(pending).rejects.toThrow();
    await held.arrived.promise;
    if (method === "fetch") f.transport.fetch = replacement;
    if (method === "assertCurrent") f.transport.assertCurrent = () => {};
    if (method === "signal") f.transport.signal = new AbortController().signal;
    held.release();
    await refused;
    expect(replacement).not.toHaveBeenCalled();
    expect(f.requests.map((r) => r.stage)).toEqual(["token", "class", "token"]);
  },
);
it.each(["immediate", "held-class"])(
  "%s edits cannot replace the title/header captured before withSaved awaits",
  async (when) => {
    const f = await saved();
    const input = { title: "Original title", header: "Original header" };
    const held = when === "held-class" ? f.hold("class") : null;
    const pending = f.invoke(input);
    if (held) await held.arrived.promise;
    input.title = "Later public title";
    input.header = "Later public header";
    held?.release();
    const result = await pending;
    const url = result.items[0]?.url;
    if (!url) throw new Error("Missing signed Save handoff");
    expect(payload(f, url)).toMatchObject({
      genericObjects: [
        {
          cardTitle: { defaultValue: { value: "Original title" } },
          header: { defaultValue: { value: "Original header" } },
        },
      ],
    });
    expect(JSON.stringify(payload(f, url))).not.toContain("Later public");
  },
);
it("original-owner abort physically closes held token work before producer release, despite replacement methods and signal", async () => {
  const f = await saved();
  const held = f.hold("token");
  const pending = f.invoke();
  const refused = expect(pending).rejects.toThrow();
  await held.arrived.promise;
  const started = Date.now();
  f.transport.assertCurrent = () => {};
  f.transport.signal = new AbortController().signal;
  f.owner.abort();
  await refused;
  await held.closed.promise;
  expect(Date.now() - started).toBeLessThan(2000);
  expect(f.requests.map((r) => r.stage)).toEqual(["token", "class", "token"]);
});
it("a receiver check that reentrantly replaces fetch cannot submit any provider work", async () => {
  const f = await fixture();
  const replacement = vi.fn<NativeProviderTransport["fetch"]>();
  f.transport.assertCurrent = function () {
    expect(this).toBe(f.transport);
    f.transport.fetch = replacement;
  };
  await expect(
    flows.configure(draft(f.account), f.transport),
  ).rejects.toThrow();
  expect(f.requests).toEqual([]);
  expect(replacement).not.toHaveBeenCalled();
});

it("a retired captured port rejects restored method identities without any provider work", async () => {
  const f = await fixture();
  const original = f.transport.fetch;
  const replacement = vi.fn<NativeProviderTransport["fetch"]>();
  const guarded = googleWalletTransportFlows({
    ...flows,
    configure: async (_input, captured) => {
      if (!captured) throw new Error("Missing captured route");
      f.transport.fetch = replacement;
      expect(() => captured.assertCurrent()).toThrow();
      f.transport.fetch = original;
      expect(() => captured.assertCurrent()).toThrow();
      throw new Error("Retired route observation complete");
    },
  });
  await expect(
    guarded.configure(draft(f.account), f.transport),
  ).rejects.toThrow("Retired route observation complete");
  expect(f.requests).toEqual([]);
});

it.each(["missing", "token-only", "class-only"])(
  "uses the original approved base carrier when optional native origin support is %s",
  async (mode) => {
    const f = await fixture();
    if (mode === "missing")
      Reflect.deleteProperty(f.transport, "supportsNativeOrigin");
    else
      f.transport.supportsNativeOrigin = (origin) =>
        origin ===
        (mode === "token-only"
          ? "https://oauth2.googleapis.com"
          : "https://walletobjects.googleapis.com");
    const view = await flows.configure(draft(f.account), f.transport);
    expect(view.status).toBe("connected");
    expect(f.requests.map((request) => request.stage)).toEqual([
      "token",
      "class",
    ]);
    expect(f.requests.every((request) => request.authorized)).toBe(true);
    expect(readDeviceRows()).toHaveLength(1);
  },
);
it("does not adopt a replacement native-origin method after original capture", async () => {
  const f = await fixture();
  const pending = flows.configure(draft(f.account), f.transport);
  const replacement = vi.fn(() => true);
  f.transport.supportsNativeOrigin = replacement;
  await expect(pending).rejects.toThrow();
  expect(f.requests).toEqual([]);
  expect(replacement).not.toHaveBeenCalled();
});
