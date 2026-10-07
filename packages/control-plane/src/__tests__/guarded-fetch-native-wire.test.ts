import { afterEach, beforeEach, expect, it } from "vitest";
import {
  type GuardedFetchInit,
  UnsafeUpstreamError,
  guardedFetch,
  guardedFetchSeams,
  guardedLibraryFetch,
} from "../services/guarded-fetch.js";
import { openPinnedWireFixture } from "./guarded-fetch-native-wire.test-support.js";

const original = { ...guardedFetchSeams };
const publicAddress = "93.184.216.34";
const base = "http://metadata.native-wire.test:8080";
let fixture: Awaited<ReturnType<typeof openPinnedWireFixture>>;
let lookups: string[];

beforeEach(async () => {
  fixture = await openPinnedWireFixture();
  lookups = [];
  guardedFetchSeams.lookup = async (hostname) => {
    lookups.push(hostname);
    return [{ address: publicAddress, family: 4 }];
  };
});

afterEach(async () => {
  Object.assign(guardedFetchSeams, original);
  await fixture.close();
});

const bodies: Array<{
  label: string;
  body: GuardedFetchInit["body"];
  expected: Buffer;
  contentType: string;
}> = [
  {
    label: "UTF-8 string",
    body: "credential=é",
    expected: Buffer.from("credential=é"),
    contentType: "text/plain",
  },
  {
    label: "URLSearchParams",
    body: new URLSearchParams({ credential: "é+ &" }),
    expected: Buffer.from("credential=%C3%A9%2B+%26"),
    contentType: "application/x-www-form-urlencoded;charset=UTF-8",
  },
  {
    label: "Uint8Array",
    body: new Uint8Array([0, 127, 255]),
    expected: Buffer.from([0, 127, 255]),
    contentType: "application/octet-stream",
  },
  {
    label: "ArrayBuffer",
    body: new Uint8Array([255, 0, 42]).buffer,
    expected: Buffer.from([255, 0, 42]),
    contentType: "application/octet-stream",
  },
];

it.each(bodies)(
  "native transport preserves $label bytes and original authority host",
  async ({ body, expected, contentType, label }) => {
    const headers = new Headers({ host: "untrusted-host.attacker.test" });
    if (label !== "URLSearchParams") headers.set("content-type", contentType);
    const response = await guardedFetch(`${base}/echo?request=bound`, true, {
      method: "POST",
      headers,
      body,
    });
    expect(guardedFetchSeams.transport).toBe(original.transport);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: "POST",
      path: "/echo?request=bound",
      host: "metadata.native-wire.test:8080",
      bodyHex: expected.toString("hex"),
      contentType,
      contentLength: String(expected.length),
    });
    expect(response.headers.get("x-metadata")).toBe("first, second");
    expect(lookups).toEqual(["metadata.native-wire.test"]);
    expect(fixture.requestedOptions).toHaveLength(1);
    expect(fixture.requestedOptions[0]).toMatchObject({
      hostname: publicAddress,
      family: 4,
      port: "8080",
      path: "/echo?request=bound",
      method: "POST",
      agent: false,
    });
  },
);

it("the actual response byte ceiling admits an exact UTF-8 bound and refuses one byte less", async () => {
  const admitted = await guardedFetch(`${base}/bytes`, true, { maxBytes: 8 });
  expect(await admitted.text()).toBe("éééé");
  await expect(
    guardedFetch(`${base}/bytes`, true, { maxBytes: 7 }),
  ).rejects.toBeInstanceOf(UnsafeUpstreamError);
  expect(fixture.seen.map((row) => row.path)).toEqual(["/bytes", "/bytes"]);
});

it("native redirects are returned without any connection to the destination", async () => {
  const response = await guardedFetch(`${base}/redirect`, true);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/followed");
  expect(fixture.seen.map((row) => row.path)).toEqual(["/redirect"]);
  expect(fixture.requestedOptions).toHaveLength(1);
});

it("native null-body metadata status remains a usable response", async () => {
  const response = await guardedFetch(`${base}/empty`, true);
  expect(response.status).toBe(204);
  expect(response.body).toBeNull();
  expect(await response.text()).toBe("");
  expect(response.headers.get("x-metadata")).toBe("empty");
});

it("an abort while physical DNS is pending prevents the native socket dispatch", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  guardedFetchSeams.lookup = async () => {
    await held;
    return [{ address: publicAddress, family: 4 }];
  };
  const controller = new AbortController();
  const pending = guardedFetch(`${base}/echo`, true, {
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  release();
  await rejected;
  expect(fixture.requestedOptions).toHaveLength(0);
  expect(fixture.seen).toHaveLength(0);
});

it("one unsafe answer refuses the entire DNS set before default transport dispatch", async () => {
  guardedFetchSeams.lookup = async () => [
    { address: publicAddress, family: 4 },
    { address: "169.254.169.254", family: 4 },
  ];
  await expect(guardedFetch(`${base}/echo`, true)).rejects.toBeInstanceOf(
    UnsafeUpstreamError,
  );
  expect(fixture.requestedOptions).toHaveLength(0);
  expect(fixture.seen).toHaveLength(0);
});

it("library streaming bodies are refused before DNS or the actual native transport", async () => {
  const fetchFor = guardedLibraryFetch(true, {
    Origin: "https://owner.example.test",
  });
  await expect(
    fetchFor(`${base}/echo`, { method: "POST", body: new ReadableStream() }),
  ).rejects.toBeInstanceOf(UnsafeUpstreamError);
  expect(lookups).toEqual([]);
  expect(fixture.requestedOptions).toHaveLength(0);
  expect(fixture.seen).toHaveLength(0);
});
