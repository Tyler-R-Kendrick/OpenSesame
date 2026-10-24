import { expect, it, vi } from "vitest";
import { type NativePeerGETNode, bindNativePeerGET } from "./sdk-peer-get.js";
type Raw = NonNullable<NativePeerGETNode["nativePeerGETPort"]>;
it.each(["http:", "https:"])(
  "captures original %s raw methods and requires original Go drain acknowledgement",
  async (protocol) => {
    const url = `${protocol}//native.test/proof`;
    type Held = {
      id: number;
      token: Parameters<Raw["begin"]>[2];
      publish: Parameters<Raw["begin"]>[3];
    };
    type Drained = {
      token: Parameters<Raw["drain"]>[0];
      publish: Parameters<Raw["drain"]>[1];
    };
    type Captured = { held: Held | null; drained: Drained | null };
    const captured: Captured = {
      held: null,
      drained: null,
    };
    const begin: Raw["begin"] = (id, _request, token, publish) => {
      captured.held = { id, token, publish };
      return "";
    };
    const raw: Raw = {
      begin,
      current: () => true,
      cancel: vi.fn(() => true),
      close: vi.fn(),
      drain: (token, publish) => {
        captured.drained = { token, publish };
        return "";
      },
    };
    const node: NativePeerGETNode = {
      nativePeerGETPort: raw,
      nativePeerGETReady: () => true,
    };
    const client = await bindNativePeerGET(
      node,
      new URL("./sdk-peer-get.fixture.mjs", import.meta.url).href,
    );
    raw.begin = () => {
      throw new Error("replacement");
    };
    const request = client.nativeHTTP(
      1,
      {
        method: "GET",
        url,
        headers: [],
        body: new Uint8Array(),
      },
      new AbortController().signal,
    );
    const delivery = captured.held;
    if (!delivery) throw new Error("Original raw begin was not called");
    delivery.publish(
      delivery.token,
      delivery.id,
      {
        status: 200,
        statusText: "OK",
        url,
        headers: [],
        body: new Uint8Array([65]),
      },
      "",
    );
    await expect(request).resolves.toMatchObject({ status: 200 });
    let done = false;
    const closing = client.close().then((value) => {
      done = true;
      return value;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    const receipt = captured.drained;
    if (!receipt) throw new Error("Original drain was not called");
    expect(receipt.publish({ id: 0 }, 0, null, "")).toBe(false);
    expect(done).toBe(false);
    receipt.publish(receipt.token, 0, null, "");
    await expect(closing).resolves.toBe(true);
    expect(client.ready()).toBe(false);
  },
);
it("refuses an absent peer ABI before importing any deployment code", async () => {
  await expect(
    bindNativePeerGET({}, "https://app.example/native.js"),
  ).rejects.toThrow("no peer GET contract");
});
