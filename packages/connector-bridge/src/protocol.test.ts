import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  type HeaderPair,
  MAX_HEADERS,
  MAX_URL_LENGTH,
  pageReplyMessage,
  pageRequestMessage,
  parsePageReply,
  parsePageRequest,
} from "./protocol.js";

const id = "req_0123456789";
const fetchBody = {
  providerId: "plivo",
  url: "https://api.plivo.com/v1/Account/x/",
  method: "GET",
  headers: [["authorization", "Basic abc"]],
  body: null,
} satisfies JsonObject;
const request = (extra: JsonObject): JsonObject => ({
  channel: BRIDGE_CHANNEL,
  version: BRIDGE_VERSION,
  direction: "request",
  id,
  ...extra,
});
const reply = (extra: JsonObject): JsonObject => ({
  channel: BRIDGE_CHANNEL,
  version: BRIDGE_VERSION,
  direction: "response",
  id,
  ...extra,
});

describe("what a page may ask", () => {
  it("accepts exactly the three operations", () => {
    expect(parsePageRequest(request({ op: "hello" }))).toEqual({
      id,
      op: "hello",
    });
    expect(
      parsePageRequest(request({ op: "need", hosts: ["api.plivo.com"] })),
    ).toEqual({ id, op: "need", hosts: ["api.plivo.com"] });
    expect(
      parsePageRequest(request({ op: "fetch", request: fetchBody })),
    ).toEqual({ id, op: "fetch", request: fetchBody });
  });

  it.each([
    ["another channel", { channel: "other" }],
    ["another version", { version: 2 }],
    ["a response", { direction: "response" }],
    ["a short id", { id: "abc" }],
    ["an id with a slash", { id: "abc/defghij" }],
    ["an unknown operation", { op: "eval" }],
    ["an extra field", { op: "hello", extra: 1 }],
    ["no hosts", { op: "need", hosts: [] }],
    ["a host with a scheme", { op: "need", hosts: ["https://api.plivo.com"] }],
    [
      "too many hosts",
      {
        op: "need",
        hosts: Array.from(
          { length: 17 },
          (_, index) => `h${index}.example.com`,
        ),
      },
    ],
    ["uppercase in a host", { op: "need", hosts: ["API.plivo.com"] }],
  ] satisfies [string, JsonObject][])("refuses %s", (_name, change) => {
    expect(parsePageRequest(request({ op: "hello", ...change }))).toBeNull();
  });

  it.each([
    ["an extra request field", { ...fetchBody, cache: "reload" }],
    [
      "a missing field",
      { providerId: "plivo", url: fetchBody.url, method: "GET", headers: [] },
    ],
    ["a method the bridge does not carry", { ...fetchBody, method: "TRACE" }],
    ["a lowercase method", { ...fetchBody, method: "get" }],
    ["a provider id with a slash", { ...fetchBody, providerId: "a/b" }],
    ["a url that is not text", { ...fetchBody, url: 5 }],
    [
      "a url past the limit",
      { ...fetchBody, url: `https://x.example/${"a".repeat(MAX_URL_LENGTH)}` },
    ],
    ["headers that are not pairs", { ...fetchBody, headers: [["a"]] }],
    ["headers that are not text", { ...fetchBody, headers: [["a", 1]] }],
    [
      "too many headers",
      {
        ...fetchBody,
        headers: Array.from({ length: MAX_HEADERS + 1 }, (_, index) => [
          `h${index}`,
          "v",
        ]),
      },
    ],
    ["a body that is not text", { ...fetchBody, body: 5 }],
  ] satisfies [string, JsonObject][])(
    "refuses a fetch with %s",
    (_name, bad) => {
      expect(
        parsePageRequest(request({ op: "fetch", request: bad })),
      ).toBeNull();
    },
  );

  it("refuses what is not an object", () => {
    const values: BoundaryValue[] = [null, undefined, "x", 5, [], [1]];
    for (const value of values) expect(parsePageRequest(value)).toBeNull();
  });

  it("round-trips through the envelope it travels in", () => {
    const asked = {
      id,
      op: "fetch" as const,
      request: {
        ...fetchBody,
        method: "GET" as const,
        headers: [["authorization", "Basic abc"]] satisfies HeaderPair[],
        body: null,
      },
    };
    expect(parsePageRequest(pageRequestMessage(asked))).toEqual(asked);
  });
});

describe("what the extension answers", () => {
  const hello = {
    bridge: "opensesame-connector-bridge",
    version: "0.1.0",
    granted: ["api.plivo.com"],
  };

  it("reads a hello, a fetch and a need, each as its own shape", () => {
    expect(parsePageReply(reply({ ok: true, result: hello }), "hello")).toEqual(
      {
        id,
        result: hello,
      },
    );
    const fetched = {
      status: 200,
      headers: [["content-type", "application/json"]],
      body: "{}",
    };
    expect(
      parsePageReply(reply({ ok: true, result: fetched }), "fetch"),
    ).toEqual({
      id,
      result: fetched,
    });
    expect(
      parsePageReply(
        reply({ ok: true, result: { pending: ["api.plivo.com"] } }),
        "need",
      ),
    ).toEqual({ id, result: { pending: ["api.plivo.com"] } });
  });

  it("reads a refusal by its code and no other", () => {
    expect(
      parsePageReply(reply({ ok: false, error: "not_granted" }), "fetch"),
    ).toEqual({ id, error: "not_granted" });
    expect(
      parsePageReply(
        reply({ ok: false, error: "a long sentence about secrets" }),
        "fetch",
      ),
    ).toBeNull();
  });

  it.each([
    ["a status under 200", { status: 100, headers: [], body: "" }],
    ["a status over 599", { status: 700, headers: [], body: "" }],
    ["a fractional status", { status: 200.5, headers: [], body: "" }],
    ["a body that is not text", { status: 200, headers: [], body: 1 }],
    ["an extra field", { status: 200, headers: [], body: "", cookies: [] }],
  ] satisfies [string, JsonObject][])(
    "refuses a fetch answer with %s",
    (_name, result) => {
      expect(parsePageReply(reply({ ok: true, result }), "fetch")).toBeNull();
    },
  );

  it("refuses a hello from another bridge or with a bad host list", () => {
    expect(
      parsePageReply(
        reply({ ok: true, result: { ...hello, bridge: "other" } }),
        "hello",
      ),
    ).toBeNull();
    expect(
      parsePageReply(
        reply({ ok: true, result: { ...hello, granted: ["BAD HOST"] } }),
        "hello",
      ),
    ).toBeNull();
  });

  it("round-trips through the envelope it travels in", () => {
    const answered = { id, result: { pending: ["api.plivo.com"] } };
    expect(parsePageReply(pageReplyMessage(answered), "need")).toEqual(
      answered,
    );
    expect(
      parsePageReply(pageReplyMessage({ id, error: "timeout" }), "fetch"),
    ).toEqual({
      id,
      error: "timeout",
    });
  });

  it("is not a request", () => {
    expect(parsePageReply(request({ op: "hello" }), "hello")).toBeNull();
  });
});
