import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretBackendHttpError, createBackendHttp } from "./http.js";
import { SecretBackendError } from "./types.js";

const envelope = JSON.stringify({
  statusCode: 403,
  error: "TokenError",
  message: "private-provider-message",
  reqId: "private-provider-request-id",
});
const encoded = new TextEncoder().encode(envelope);
const jsonHeaders = { "content-type": "application/json" };

async function forbidden(
  response: Response | Promise<Response>,
  signal?: AbortSignal,
): Promise<SecretBackendHttpError> {
  const request = createBackendHttp(
    "https://configured.example.test",
    async () => response,
  );
  try {
    await request("items", {
      signal,
      headers: { authorization: "Bearer private-request-token" },
    });
  } catch (error) {
    if (error instanceof SecretBackendHttpError) return error;
    throw error;
  }
  throw new Error("Expected an HTTP failure");
}

function sanitized(error: SecretBackendHttpError, kind: "token-error" | null) {
  expect(error).toBeInstanceOf(SecretBackendError);
  expect(error).toMatchObject({
    name: "SecretBackendError",
    code: "authentication",
    status: 403,
    message: "The backend refused these credentials or permissions.",
    responseKind: kind,
  });
  const retained = JSON.stringify(Object.getOwnPropertyDescriptors(error));
  expect(retained).not.toContain("private-");
  expect(retained).not.toContain("configured.example.test");
  expect(String(error)).not.toContain("private-");
  expect(JSON.stringify(error)).not.toContain("private-");
  for (const key of ["cause", "body", "response", "headers", "url"])
    expect(error).not.toHaveProperty(key);
}

function pendingBody(cancel: () => void | Promise<void> = () => undefined) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancelled = vi.fn(cancel);
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel: cancelled,
  });
  return {
    body,
    cancelled,
    response: new Response(body, { status: 403, headers: jsonHeaders }),
    send(bytes: Uint8Array, close = false) {
      if (!controller) throw new Error("Missing controlled stream");
      controller.enqueue(bytes);
      if (close) controller.close();
    },
    fail(error: Error) {
      if (!controller) throw new Error("Missing controlled stream");
      controller.error(error);
    },
  };
}

function deadline() {
  vi.useFakeTimers();
  const owner = new AbortController();
  const source = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((delay) => {
      setTimeout(
        () => source.abort(new Error("private-deadline-reason")),
        delay,
      );
      return source.signal;
    });
  return { owner, source, timeout };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded token-error response metadata", () => {
  it.each([
    "application/json",
    "APPLICATION/JSON; charset=utf-8",
    "application/problem+json",
  ])("recognizes only the safe literal with media %s", async (media) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 11));
        controller.enqueue(encoded.subarray(11));
        controller.close();
      },
    });
    const error = await forbidden(
      new Response(body, {
        status: 403,
        headers: {
          "content-type": media,
          "x-private-header": "private-header",
        },
      }),
    );
    sanitized(error, "token-error");
    expect(body.locked).toBe(false);
  });

  it.each([
    '{"statusCode":403,"error":"PermissionDenied"}',
    '{"statusCode":403,"error":"OtherError"}',
    '{"statusCode":401,"error":"TokenError"}',
    '{"statusCode":"403","error":"TokenError"}',
    '{"error":"TokenError"}',
    '{"statusCode":403}',
    '{"__proto__":{"statusCode":403,"error":"TokenError"}}',
    '[[403,"TokenError"]]',
    '"TokenError"',
    "null",
    "403",
    "{",
    "",
  ])("keeps an unmatched JSON body generic: %s", async (body) => {
    sanitized(
      await forbidden(
        new Response(body, { status: 403, headers: jsonHeaders }),
      ),
      null,
    );
  });

  it.each(["text/plain", "text/json", "application/jsonp", ""])(
    "does not recognize JSON-looking bytes with media %s",
    async (media) => {
      const f = pendingBody();
      f.response.headers.set("content-type", media);
      sanitized(await forbidden(f.response), null);
      expect(f.cancelled).toHaveBeenCalledOnce();
      expect(f.body.locked).toBe(false);
    },
  );

  it("requires valid UTF-8 and an actual body", async () => {
    const invalid = new Uint8Array([...encoded, 0xff]);
    sanitized(
      await forbidden(
        new Response(invalid, { status: 403, headers: jsonHeaders }),
      ),
      null,
    );
    sanitized(await forbidden(new Response(null, { status: 403 })), null);
  });

  it.each([4096, 4097])(
    "bounds actual bytes at %s despite a false length",
    async (size) => {
      const f = pendingBody();
      f.response.headers.set("content-length", "0");
      const result = forbidden(f.response);
      const bytes = new Uint8Array(size).fill(32);
      bytes.set(encoded);
      f.send(bytes, size === 4096);
      sanitized(await result, size === 4096 ? "token-error" : null);
      expect(f.cancelled).toHaveBeenCalledTimes(size === 4096 ? 0 : 1);
      expect(f.body.locked).toBe(false);
    },
  );

  it.each(["throw", "reject", "hang"] as const)(
    "does not await or expose a %s cancellation after the bound",
    async (mode) => {
      const f = pendingBody(() => {
        if (mode === "throw") throw new Error("private-cancel-reason");
        if (mode === "reject")
          return Promise.reject(new Error("private-cancel-reason"));
        return new Promise<void>(() => undefined);
      });
      const result = forbidden(f.response);
      f.send(new Uint8Array(2048));
      f.send(new Uint8Array(2048));
      f.send(new Uint8Array(1));
      sanitized(await result, null);
      expect(f.cancelled).toHaveBeenCalledOnce();
      expect(f.body.locked).toBe(false);
    },
  );

  it.each([401, 404, 429, 500])(
    "does not classify the envelope on HTTP%s",
    async (status) => {
      const error = await forbidden(
        new Response(envelope, { status, headers: jsonHeaders }),
      );
      expect(error.status).toBe(status);
      expect(error.responseKind).toBeNull();
    },
  );

  it("bounds an endless stream of empty chunks", async () => {
    const cancel = vi.fn();
    const pull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array(0));
      },
    );
    const body = new ReadableStream<Uint8Array>({ pull, cancel });
    sanitized(
      await forbidden(
        new Response(body, { status: 403, headers: jsonHeaders }),
      ),
      null,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull.mock.calls.length).toBeLessThan(5);
    expect(body.locked).toBe(false);
  });

  it("derives factory metadata only from the bounded actual403 response", async () => {
    const signal = new AbortController().signal;
    for (const status of [0, 401, 403, 500]) {
      const response =
        status === 0
          ? Response.error()
          : Response.json({ statusCode: 401, error: "TokenError" }, { status });
      const error = await SecretBackendHttpError.fromResponse(
        response,
        "authentication",
        "Safe factory message.",
        signal,
      );
      expect(error).not.toMatchObject({ responseKind: "token-error" });
    }
  });

  it("does not infer metadata from a success or arbitrary thrown data", async () => {
    const request = createBackendHttp(
      "https://configured.example.test",
      async () => Response.json({ statusCode: 403, error: "TokenError" }),
    );
    await expect(request("items")).resolves.toEqual({
      statusCode: 403,
      error: "TokenError",
    });
    const broken = createBackendHttp(
      "https://configured.example.test",
      async () => {
        throw Object.assign(new Error("private-thrown-reason"), {
          status: 403,
          responseKind: "token-error",
        });
      },
    );
    await expect(broken("items")).rejects.toMatchObject({ code: "network" });
    await expect(broken("items")).rejects.not.toHaveProperty("responseKind");
  });
});

describe("token-error reader request ownership", () => {
  it.each([0, 19_900])(
    "uses the original20s deadline after headers delayed%s ms",
    async (delay) => {
      const d = deadline();
      const f = pendingBody(() => new Promise<void>(() => undefined));
      let deliver: ((response: Response) => void) | undefined;
      const headers = new Promise<Response>((resolve) => {
        deliver = resolve;
      });
      const result = forbidden(headers, d.owner.signal);
      await vi.advanceTimersByTimeAsync(delay);
      if (!deliver) throw new Error("Missing response delivery");
      deliver(f.response);
      await vi.advanceTimersByTimeAsync(19_999 - delay);
      expect(f.body.locked).toBe(true);
      expect(d.source.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      sanitized(await result, null);
      expect(d.timeout).toHaveBeenCalledExactlyOnceWith(20_000);
      expect(d.owner.signal.aborted).toBe(false);
      expect(f.cancelled).toHaveBeenCalledOnce();
      expect(f.body.locked).toBe(false);
    },
  );

  it("honors earlier native-combined cancellation and observes late cancel rejection", async () => {
    const d = deadline();
    const native = new AbortController();
    let rejectCancel: ((error: Error) => void) | undefined;
    const f = pendingBody(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCancel = reject;
        }),
    );
    const signal = AbortSignal.any([d.owner.signal, native.signal]);
    const result = forbidden(f.response, signal);
    await vi.advanceTimersByTimeAsync(100);
    native.abort(new Error("private-native-reason"));
    sanitized(await result, null);
    expect(d.owner.signal.aborted).toBe(false);
    expect(d.source.signal.aborted).toBe(false);
    expect(f.cancelled).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
    if (!rejectCancel) throw new Error("Missing cancel rejection");
    rejectCancel(new Error("private-late-cancel-reason"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(19_900);
    expect(d.source.signal.aborted).toBe(true);
  });

  it("ignores already-ended ownership and abort after the final chunk", async () => {
    const d = deadline();
    d.owner.abort(new Error("private-ended-reason"));
    sanitized(
      await forbidden(
        Response.json(JSON.parse(envelope), { status: 403 }),
        d.owner.signal,
      ),
      null,
    );
    const live = new AbortController();
    const f = pendingBody(() => new Promise<void>(() => undefined));
    const result = forbidden(f.response, live.signal);
    await vi.advanceTimersByTimeAsync(0);
    f.send(encoded);
    queueMicrotask(() => live.abort(new Error("private-final-chunk-reason")));
    sanitized(await result, null);
    expect(f.cancelled).toHaveBeenCalledOnce();
    expect(f.body.locked).toBe(false);
  });

  it.each([false, true])(
    "observes stream failure after abort=%s and detaches",
    async (aborted) => {
      const d = deadline();
      const add = vi.spyOn(d.source.signal, "addEventListener");
      const remove = vi.spyOn(d.source.signal, "removeEventListener");
      const f = pendingBody();
      const result = forbidden(f.response);
      await vi.advanceTimersByTimeAsync(0);
      if (aborted) d.source.abort(new Error("private-reader-abort-reason"));
      f.fail(new Error("private-read-reason"));
      sanitized(await result, null);
      expect(f.body.locked).toBe(false);
      const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
      expect(listener).toBeTypeOf("function");
      expect(remove).toHaveBeenCalledWith("abort", listener);
    },
  );
});
