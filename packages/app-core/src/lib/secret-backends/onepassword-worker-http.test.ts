import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOnePasswordWorkerFetch } from "./onepassword-worker-fetch.js";
import { createOnePasswordWorkerHttp } from "./onepassword-worker-http.js";
import {
  ONEPASSWORD_HTTP_MAX_BYTES as MAX_BYTES,
  ONEPASSWORD_HTTP_MAX_PENDING as MAX_PENDING,
  type OnePasswordFetchMessage,
  type OnePasswordFetchRequest,
  type OnePasswordFetchResult,
  OnePasswordFetchResultSchema,
  ONEPASSWORD_HTTP_SESSION_REQUESTS as SESSION_REQUESTS,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendTransport } from "./transport.js";

const origin = "https://account.example";
const url = `${origin}/api/v3/auth/start`;
const safeFailure =
  "The 1Password network request failed or its session ended.";
const failure = { type: "fetch-result", id: 1, ok: false } as const;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function request(id = 1): OnePasswordFetchRequest {
  return {
    type: "fetch",
    id,
    url,
    method: "GET",
    headers: [],
    body: new Uint8Array(),
  };
}
function success(id = 1): OnePasswordFetchResult {
  return {
    type: "fetch-result",
    id,
    ok: true,
    url,
    status: 200,
    statusText: "OK",
    headers: [],
    body: new Uint8Array([0, 255, 128]),
  };
}
class WireResponse extends Response {
  override get url() {
    return url;
  }
}
function transport(fetcher: SecretBackendTransport["fetch"]) {
  const controller = new AbortController();
  let current = true;
  const port: SecretBackendTransport = {
    fetch: fetcher,
    signal: controller.signal,
    assertCurrent() {
      if (!current) throw new Error("private lease detail");
    },
  };
  return {
    port,
    abort: () => controller.abort(),
    withdraw: () => {
      current = false;
    },
  };
}
function broker(port: SecretBackendTransport, deadlineMs = 20_000) {
  const http = createOnePasswordWorkerHttp(origin, port, deadlineMs);
  cleanup.push(http.close);
  return http;
}
function worker(post: (message: OnePasswordFetchMessage) => void) {
  const bridge = createOnePasswordWorkerFetch(post);
  cleanup.push(bridge.close);
  return bridge;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("1Password captured binary HTTP boundary", () => {
  it.each([200, 401])(
    "preserves real socket bytes and readable HTTP %i with URL",
    async (status) => {
      const received = deferred<Buffer>();
      let redirectedCalls = 0;
      let authorization: string | undefined;
      const server = createServer(async (incoming, response) => {
        if (incoming.url === "/redirect") {
          response.writeHead(302, { Location: "/unexpected" });
          response.end();
          return;
        }
        if (incoming.url === "/unexpected") redirectedCalls++;
        authorization = incoming.headers.authorization;
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        received.resolve(Buffer.concat(chunks));
        response.writeHead(status, {
          "Content-Type": "application/octet-stream",
          "X-Request-Id": "visible",
        });
        response.end(Buffer.from([255, 0, 128, 13]));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      cleanup.push(async () => {
        server.closeAllConnections();
        server.close();
        await once(server, "close");
      });
      const address = z.object({ port: z.number() }).parse(server.address());
      const base = `http://127.0.0.1:${address.port}`;
      const settings: RequestInit[] = [];
      const port = transport(async (input, init = {}) => {
        settings.push(init);
        return fetch(input, init);
      });
      const http = createOnePasswordWorkerHttp(base, port.port);
      cleanup.push(http.close);
      const bridge = worker((message) => {
        http.receive(message, (result) => bridge.receive(result));
      });
      const response = await bridge.fetch(
        `${base}/api/v3/auth/start?challenge=1`,
        {
          method: "POST",
          body: new Uint8Array([0, 255, 128, 10]),
          headers: { Authorization: "Bearer fixture-token" },
          credentials: "include",
          redirect: "follow",
        },
      );
      expect([...(await received.promise)]).toEqual([0, 255, 128, 10]);
      expect(authorization).toBe("Bearer fixture-token");
      expect(response.url).toBe(`${base}/api/v3/auth/start?challenge=1`);
      expect(response.status).toBe(status);
      expect(response.ok).toBe(status === 200);
      expect(response.headers.get("x-request-id")).toBe("visible");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes]).toEqual([255, 0, 128, 13]);
      expect(settings[0]).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      await expect(bridge.fetch(`${base}/redirect`)).rejects.toThrow(
        safeFailure,
      );
      expect(redirectedCalls).toBe(0);
    },
  );

  it.each([
    "https://other.example/api",
    "blob:https://account.example/id",
    "http://account.example/api",
    "https://user:secret@account.example/api",
    `${url}#fragment`,
    "Cookie",
    "Origin",
    "Host",
    "Proxy-Authorization",
    "Sec-Fetch-Site",
    "Content-Length",
  ])("rejects account escapes and forged headers: %s", async (target) => {
    const fetched = vi.fn();
    const message: OnePasswordFetchRequest = target.includes(":")
      ? { ...request(), url: target }
      : { ...request(), headers: [[target, "secret"]] };
    const post = vi.fn();
    broker(transport(fetched).port).receive(message, post);
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(failure));
    expect(fetched).not.toHaveBeenCalled();
  });

  it("rejects unsafe IDs, oversized messages and unrecognized fields before authority", () => {
    const fetched = vi.fn();
    const http = broker(transport(fetched).port);
    for (const id of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
    ])
      expect(http.receive({ ...request(), id }, vi.fn())).toBe(false);
    expect(
      http.receive({ ...request(), token: "never accepted" }, vi.fn()),
    ).toBe(false);
    const oversized = { ...request(), body: new Uint8Array(MAX_BYTES + 1) };
    expect(http.receive(oversized, vi.fn())).toBe(false);
    expect(
      OnePasswordFetchResultSchema.safeParse({ ...success(), status: 0 })
        .success,
    ).toBe(false);
    expect(fetched).not.toHaveBeenCalled();
  });

  it.each(["declared", "streamed"])("bounds %s body", async (kind) => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (kind === "streamed")
          controller.enqueue(new Uint8Array(MAX_BYTES + 1));
      },
      cancel: cancelled,
    });
    const response = new WireResponse(body, {
      headers:
        kind === "declared" ? { "Content-Length": String(MAX_BYTES + 1) } : {},
    });
    const post = vi.fn();
    broker(transport(async () => response).port).receive(request(), post);
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(failure));
    expect(cancelled).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each(["abort", "close", "withdraw", "cancel"])(
    "drops %s during response streaming without a late success or failure",
    async (action) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        cancel: cancelled,
      });
      const port = transport(async () => new WireResponse(body));
      const closed = vi.fn(() => {
        throw new Error("private cleanup failure");
      });
      const http = createOnePasswordWorkerHttp(
        origin,
        port.port,
        20_000,
        closed,
      );
      cleanup.push(http.close);
      const post = vi.fn();
      http.receive(request(), post);
      await vi.waitFor(() => expect(body.locked).toBe(true));
      if (action === "close") http.close();
      else if (action === "abort") port.abort();
      else if (action === "cancel")
        http.receive({ type: "fetch-cancel", id: 1 }, post);
      else {
        port.withdraw();
        controller.enqueue(new Uint8Array([1]));
      }
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      expect(post).not.toHaveBeenCalled();
      expect(closed).toHaveBeenCalledTimes(action === "cancel" ? 0 : 1);
      http.close();
      expect(closed).toHaveBeenCalledOnce();
    },
  );

  it.each(["success", "failure"])("drops %s on close", async (outcome) => {
    const held = deferred<Response>();
    const http = broker(transport(() => held.promise).port);
    const post = vi.fn();
    http.receive(request(), post);
    http.close();
    if (outcome === "success")
      held.resolve(new WireResponse("private response"));
    else held.reject(new Error("private token in transport error"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(post).not.toHaveBeenCalled();
    expect(http.receive(request(2), post)).toBe(false);
  });

  it("enforces a deadline even when the captured fetch ignores its signal", async () => {
    const held = deferred<Response>();
    const post = vi.fn();
    broker(transport(() => held.promise).port, 5).receive(request(), post);
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(failure));
    held.resolve(new WireResponse("late"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(post).toHaveBeenCalledOnce();
  });

  it("rejects pending and settled replays while accepting out-of-order IDs", async () => {
    const fetched = vi.fn(async () => new WireResponse("ok"));
    const http = broker(transport(fetched).port);
    const post = vi.fn();
    expect(http.receive(request(2), post)).toBe(true);
    expect(http.receive(request(2), post)).toBe(false);
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(http.receive(request(2), post)).toBe(false);
    expect(http.receive(request(1), post)).toBe(true);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it("bounds main outstanding requests and total remembered IDs", async () => {
    const held = deferred<Response>();
    const http = broker(transport(() => held.promise).port);
    for (let id = 1; id <= MAX_PENDING; id++)
      expect(http.receive(request(id), vi.fn())).toBe(true);
    expect(http.receive(request(100), vi.fn())).toBe(false);
    expect(() => http.assertCurrent()).toThrow();
    held.resolve(new WireResponse("late"));
    const port = transport(async () => new WireResponse(null));
    const stop = () => bridge.close();
    const serial = createOnePasswordWorkerHttp(origin, port.port, 20_000, stop);
    cleanup.push(serial.close);
    const bridge = worker((message) => {
      serial.receive(message, (result) => bridge.receive(result));
    });
    for (let id = 1; id <= SESSION_REQUESTS; id++) await bridge.fetch(url);
    await expect(bridge.fetch(url)).rejects.toThrow(safeFailure);
    expect(() => serial.assertCurrent()).toThrow();
  });

  it.each(["abort", "close"])(
    "%s while serializing request bytes cancels the stream without posting",
    async (action) => {
      const cancelled = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
      const controller = new AbortController();
      const post = vi.fn();
      const bridge = worker(post);
      const init = {
        method: "POST",
        body: stream,
        signal: controller.signal,
        duplex: "half",
      };
      const pending = expect(bridge.fetch(url, init)).rejects.toThrow(
        safeFailure,
      );
      if (action === "abort") controller.abort();
      else bridge.close();
      await pending;
      expect(cancelled).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("cancels a dispatched request, rejects close, and ignores duplicate/unknown replies", async () => {
    const messages: OnePasswordFetchMessage[] = [];
    const bridge = worker((message) => messages.push(message));
    const controller = new AbortController();
    const cancelled = expect(
      bridge.fetch(url, { signal: controller.signal }),
    ).rejects.toThrow(safeFailure);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    controller.abort();
    await cancelled;
    expect(messages[1]).toEqual({ type: "fetch-cancel", id: 1 });
    expect(bridge.receive(success())).toBe(true);
    const pending = bridge.fetch(url);
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(bridge.receive(success(999))).toBe(true);
    expect(bridge.receive(success(2))).toBe(true);
    expect(bridge.receive(success(2))).toBe(true);
    const bytes = new Uint8Array(await (await pending).arrayBuffer());
    expect([...bytes]).toEqual([0, 255, 128]);
    const closing = expect(bridge.fetch(url)).rejects.toThrow(safeFailure);
    bridge.close();
    await closing;
    await expect(bridge.fetch(url)).rejects.toThrow(safeFailure);
  });

  it("bounds worker pending requests, rejects malformed/wrong-URL replies and safe post failures", async () => {
    const messages: OnePasswordFetchMessage[] = [];
    const bridge = worker((message) => messages.push(message));
    const failures = Array.from({ length: MAX_PENDING }, () =>
      expect(bridge.fetch(url)).rejects.toThrow(safeFailure),
    );
    await expect(bridge.fetch(url)).rejects.toThrow(safeFailure);
    await vi.waitFor(() => expect(messages).toHaveLength(MAX_PENDING));
    expect(bridge.receive({ ...success(), status: 100 })).toBe(false);
    expect(bridge.receive({ ...success(), url: "https://wrong.example" })).toBe(
      true,
    );
    bridge.close();
    await Promise.all(failures);
    await expect(
      worker(() => {
        throw new Error("raw token");
      }).fetch(url),
    ).rejects.toThrow(safeFailure);
  });
});
