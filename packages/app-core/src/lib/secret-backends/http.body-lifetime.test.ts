import { once } from "node:events";
import { type ServerResponse, createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBackendHttp } from "./http.js";

const MAX_BYTES = 4 * 1024 * 1024;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function heldResponse(body: Buffer) {
  const closed = deferred();
  const server = createServer((_request, response: ServerResponse) => {
    response.on("close", closed.resolve);
    response.writeHead(200, { "content-type": "application/json" });
    response.write(body);
    // Deliberately leave the producer open: the client must close its actual socket.
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return { url: `http://127.0.0.1:${port}`, closed };
}
function observedFetch() {
  const headers = deferred();
  const fetcher = async (input: string | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    headers.resolve();
    return response;
  };
  return { headers, fetcher };
}
it("refuses an oversized open stream and physically closes it instead of waiting for another tee consumer", async () => {
  const server = await heldResponse(Buffer.alloc(MAX_BYTES + 1, 32));
  const request = createBackendHttp(server.url);
  await expect(request("/oversized")).rejects.toMatchObject({
    code: "response",
    message: "The backend response exceeds the supported size.",
  });
  await server.closed.promise;
}, 10_000);

it.each(["caller", "deadline"])(
  "withdraws both body consumers and closes the actual socket on %s cancellation, including a SyntaxError reason before JSON bytes",
  async (source) => {
    const server = await heldResponse(Buffer.alloc(0));
    const caller = new AbortController();
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    const observed = observedFetch();
    const request = createBackendHttp(server.url, observed.fetcher);
    const pending = request("/held", { signal: caller.signal }).catch(
      (error: Error) => error,
    );
    await observed.headers.promise;
    (source === "caller" ? caller : deadline).abort(
      new SyntaxError("private-cancellation-detail"),
    );
    const error = await pending;
    if (!(error instanceof Error))
      throw new Error("Expected body cancellation rejection.");
    expect(error).toMatchObject({
      code: "response",
      name: "SecretBackendError",
    });
    expect(error.message).not.toContain("private-cancellation-detail");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(20_000);
    expect((source === "caller" ? deadline : caller).signal.aborted).toBe(
      false,
    );
    await server.closed.promise;
  },
  10_000,
);

it("accepts JSON at the exact streaming byte limit without a content length", async () => {
  const text = `"${"x".repeat(MAX_BYTES - 2)}"`;
  const request = createBackendHttp(
    "https://owned.example/",
    async () => new Response(text),
  );
  await expect(request("value")).resolves.toHaveLength(MAX_BYTES - 2);
});

it("preserves empty successful responses while refusing an errored empty stream with the same SyntaxError class", async () => {
  const empty = createBackendHttp(
    "https://owned.example/",
    async () => new Response(""),
  );
  await expect(empty("empty")).resolves.toBeNull();
  const broken = createBackendHttp(
    "https://owned.example/",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new SyntaxError("private-stream-failure"));
          },
        }),
      ),
  );
  await expect(broken("error")).rejects.toMatchObject({ code: "response" });
  await expect(broken("error")).rejects.not.toThrow("private-stream-failure");
});

it("decodes Unicode split across stream chunks and keeps malformed nonempty JSON a sanitized failure", async () => {
  const bytes = new TextEncoder().encode('{"notes":"élève / 🔐"}');
  const request = createBackendHttp(
    "https://owned.example/",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < bytes.byteLength; offset++)
              controller.enqueue(bytes.slice(offset, offset + 1));
            controller.close();
          },
        }),
      ),
  );
  await expect(request("unicode")).resolves.toEqual({ notes: "élève / 🔐" });
  const malformed = createBackendHttp(
    "https://owned.example/",
    async () => new Response("private-malformed-value"),
  );
  await expect(malformed("invalid")).rejects.toMatchObject({
    code: "response",
  });
  await expect(malformed("invalid")).rejects.not.toThrow(
    "private-malformed-value",
  );
});
