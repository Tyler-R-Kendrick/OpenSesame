/** @vitest-environment jsdom */
/** @vitest-environment-options { "url": "https://support.example.com/app/" } */
import { expect, it } from "vitest";
import { readAgUiEndpointUrl } from "./endpoint.js";
import { createAgUiTransport } from "./transport.js";

it("aborts a live response when the consumer stops, without aborting its caller", async () => {
  const endpoint = readAgUiEndpointUrl("https://support.example.com/agui");
  if (!endpoint) throw new Error("fixture endpoint must be accepted");
  const caller = new AbortController();
  let postSignal: AbortSignal | null | undefined;
  let sawAbort = false;
  const transport = createAgUiTransport({
    fetchImpl: async (_input, init) => {
      if (init.method === "HEAD") {
        return new Response(null, {
          headers: { "X-OpenSesame-Support-Session": "active" },
        });
      }
      postSignal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"TEXT_MESSAGE_START","messageId":"m"}\n\n',
            ),
          );
          init.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              controller.error(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const stream = transport({
    endpoint,
    body: {
      version: 2,
      pageId: "pages",
      route: "connections",
      featureIds: [],
      question: "help",
    },
    signal: caller.signal,
  });
  for await (const _event of stream) break;
  expect(postSignal?.aborted).toBe(true);
  expect(sawAbort).toBe(true);
  expect(caller.signal.aborted).toBe(false);
});

it("forwards a caller abort while an actual client reader is open", async () => {
  const endpoint = readAgUiEndpointUrl("https://support.example.com/agui");
  if (!endpoint) throw new Error("fixture endpoint must be accepted");
  const caller = new AbortController();
  let postSignal: AbortSignal | null | undefined;
  let sawAbort = false;
  const transport = createAgUiTransport({
    fetchImpl: async (_input, init) => {
      if (init.method === "HEAD") {
        return new Response(null, {
          headers: { "X-OpenSesame-Support-Session": "active" },
        });
      }
      postSignal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"TEXT_MESSAGE_START","messageId":"m"}\n\n',
            ),
          );
          init.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              controller.error(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const iterator = transport({
    endpoint,
    body: {
      version: 2,
      pageId: "pages",
      route: "connections",
      featureIds: [],
      question: "help",
    },
    signal: caller.signal,
  })[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  caller.abort("caller stopped");
  expect((await iterator.next()).done).toBe(true);
  expect(postSignal?.aborted).toBe(true);
  expect(postSignal?.reason).toBe("caller stopped");
  expect(sawAbort).toBe(true);
});
