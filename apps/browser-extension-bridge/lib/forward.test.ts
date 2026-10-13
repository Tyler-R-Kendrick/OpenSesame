import {
  type BridgeFetchRequest,
  MAX_RESPONSE_BODY,
} from "@opensesame/connector-bridge";
import { describe, expect, it } from "vitest";
import { forward } from "./forward.js";
import { fakePorts } from "./test-ports.js";

const URL_OK = new URL("https://api.plivo.com/v1/Account/x/");
const request: BridgeFetchRequest = {
  providerId: "plivo",
  url: URL_OK.href,
  method: "GET",
  headers: [],
  body: null,
};

describe("forward", () => {
  it("returns status, headers and the body as text, with no cookie in the headers", async () => {
    const fake = fakePorts(async () => {
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", "a=b");
      return new Response('{"ok":true}', { status: 200, headers });
    });
    const sent = await forward(fake.ports, URL_OK, request, [
      ["authorization", "Basic abc"],
    ]);
    expect(sent).toEqual({
      ok: true,
      response: {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: '{"ok":true}',
      },
    });
    expect(fake.sent[0]?.init.headers).toEqual([
      ["authorization", "Basic abc"],
    ]);
  });

  it("answers an error status as a response, not a failure", async () => {
    const fake = fakePorts(async () => new Response("no", { status: 401 }));
    const sent = await forward(fake.ports, URL_OK, request, []);
    expect(sent).toMatchObject({
      ok: true,
      response: { status: 401, body: "no" },
    });
  });

  it("sends no body back for a HEAD or a 204", async () => {
    const head = fakePorts(async () => new Response(null, { status: 200 }));
    expect(
      await forward(head.ports, URL_OK, { ...request, method: "HEAD" }, []),
    ).toMatchObject({
      ok: true,
      response: { body: "" },
    });
    const none = fakePorts(async () => new Response(null, { status: 204 }));
    expect(await forward(none.ports, URL_OK, request, [])).toMatchObject({
      ok: true,
      response: { status: 204, body: "" },
    });
  });

  it("refuses a body past the limit", async () => {
    const fake = fakePorts(
      async () => new Response("a".repeat(MAX_RESPONSE_BODY + 1)),
    );
    expect(await forward(fake.ports, URL_OK, request, [])).toEqual({
      ok: false,
      code: "too_large",
    });
  });

  it("refuses a body that is not text", async () => {
    const fake = fakePorts(
      async () => new Response(new Uint8Array([0xff, 0xfe, 0xfd])),
    );
    expect(await forward(fake.ports, URL_OK, request, [])).toEqual({
      ok: false,
      code: "network",
    });
  });

  it("calls a failed request a network failure, and a redirect a refusal", async () => {
    const failing = fakePorts(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await forward(failing.ports, URL_OK, request, [])).toEqual({
      ok: false,
      code: "network",
    });
    const redirected = fakePorts(async () => {
      const response = new Response("", { status: 200 });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    expect(await forward(redirected.ports, URL_OK, request, [])).toEqual({
      ok: false,
      code: "redirect_refused",
    });
  });

  it("calls an aborted request a timeout", async () => {
    const fake = fakePorts(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    expect(await forward(fake.ports, URL_OK, request, [])).toEqual({
      ok: false,
      code: "timeout",
    });
  });
});
