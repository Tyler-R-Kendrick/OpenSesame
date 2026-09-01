/** @vitest-environment jsdom */
/**
 * The default transport, driven through its two seams: the module loader and
 * `fetch`. `@ag-ui/client` is never imported here — the loader stands in for
 * it, which is the whole point of the seam.
 */

import { type JsonValue, overlapCast } from "@opensesame/os-domain";
import { SupportError } from "@opensesame/support-agent";
import { describe, expect, it } from "vitest";
import { type AgUiEndpoint, readAgUiEndpointUrl } from "./endpoint.js";
import type { AgUiOutboundBody } from "./outbound.js";
import {
  type AgUiClientLoader,
  type AgUiFetch,
  type AgUiHttpOpen,
  createAgUiTransport,
} from "./transport.js";

function endpoint(): AgUiEndpoint {
  const parsed = readAgUiEndpointUrl("https://support.example.com/agui");
  if (parsed === null) throw new Error("fixture endpoint must be accepted");
  return parsed;
}

const BODY: AgUiOutboundBody = {
  version: 1,
  instructions: "rules",
  context: {
    version: 1,
    pageId: "pages",
    route: "connections",
    targets: [],
    routes: [],
    state: [],
    capabilities: [],
    goals: [],
  },
  history: [],
  question: "How do I add a connection?",
};

function fakeResponse(status: number): Response {
  // SAFETY: sendSupportRequest reads only `ok` and `status`; this fixture
  // implements exactly that boundary contract and nothing else is touched.
  return overlapCast({ ok: status >= 200 && status < 300, status });
}

type Attempt = { readonly input: string; readonly init: RequestInit };

/**
 * A client that behaves the way `@ag-ui/client` does: it defers the request
 * until subscription, then turns it into events or an error.
 */
function fakeLoader(
  events: readonly JsonValue[],
  closed: string[],
): AgUiClientLoader {
  return async () => ({
    open: (request: AgUiHttpOpen) => ({
      subscribe: (observer) => {
        void request().then(
          () => {
            for (const event of events) observer.next(event);
            observer.complete();
          },
          (cause: Error) => observer.error(cause),
        );
        return {
          unsubscribe: () => {
            closed.push("unsubscribed");
          },
        };
      },
    }),
  });
}

async function drain(stream: AsyncIterable<JsonValue>): Promise<JsonValue[]> {
  const seen: JsonValue[] = [];
  for await (const event of stream) seen.push(event);
  return seen;
}

describe("createAgUiTransport", () => {
  it("posts the body with no ambient credentials and no redirect", async () => {
    const attempts: Attempt[] = [];
    const fetchImpl: AgUiFetch = async (input, init) => {
      attempts.push({ input, init });
      return fakeResponse(200);
    };
    const transport = createAgUiTransport({
      loadClient: fakeLoader([{ type: "RUN_FINISHED" }], []),
      fetchImpl,
    });

    await drain(
      transport({
        endpoint: endpoint(),
        body: BODY,
        signal: new AbortController().signal,
      }),
    );

    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];
    expect(attempt?.input).toBe("https://support.example.com/agui");
    expect(attempt?.init.method).toBe("POST");
    expect(attempt?.init.credentials).toBe("omit");
    expect(attempt?.init.redirect).toBe("error");
    expect(attempt?.init.referrerPolicy).toBe("no-referrer");
    expect(attempt?.init.cache).toBe("no-store");
    expect(attempt?.init.headers).toStrictEqual({
      "content-type": "application/json",
      accept: "text/event-stream",
    });
    expect(attempt?.init.body).toBe(JSON.stringify(BODY));
  });

  it("yields the events the client decodes, then releases the subscription", async () => {
    const closed: string[] = [];
    const transport = createAgUiTransport({
      loadClient: fakeLoader(
        [
          { type: "TEXT_MESSAGE_START", messageId: "m1" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" },
        ],
        closed,
      ),
      fetchImpl: async () => fakeResponse(200),
    });

    const seen = await drain(
      transport({
        endpoint: endpoint(),
        body: BODY,
        signal: new AbortController().signal,
      }),
    );

    expect(seen).toStrictEqual([
      { type: "TEXT_MESSAGE_START", messageId: "m1" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hi" },
    ]);
    expect(closed).toEqual(["unsubscribed"]);
  });

  it("refuses a non-200 answer before any event is decoded", async () => {
    const transport = createAgUiTransport({
      loadClient: fakeLoader([{ type: "TEXT_MESSAGE_CHUNK", delta: "x" }], []),
      fetchImpl: async () => fakeResponse(502),
    });

    const failure = await drain(
      transport({
        endpoint: endpoint(),
        body: BODY,
        signal: new AbortController().signal,
      }),
    ).then(
      () => null,
      (cause: Error) => cause,
    );

    expect(failure).toBeInstanceOf(SupportError);
    expect(failure).toMatchObject({ code: "AGENT_PROTOCOL_ERROR" });
    expect(failure?.message).toContain("502");
  });

  it("surfaces a connection failure as a stream error", async () => {
    const transport = createAgUiTransport({
      loadClient: fakeLoader([], []),
      fetchImpl: async () => {
        throw new Error("network unreachable");
      },
    });

    const failure = await drain(
      transport({
        endpoint: endpoint(),
        body: BODY,
        signal: new AbortController().signal,
      }),
    ).then(
      () => null,
      (cause: Error) => cause,
    );

    expect(failure).toBeInstanceOf(Error);
  });

  it("makes no request at all when the run is already cancelled", async () => {
    let requested = 0;
    const controller = new AbortController();
    controller.abort();
    const transport = createAgUiTransport({
      loadClient: fakeLoader([{ type: "RUN_FINISHED" }], []),
      fetchImpl: async () => {
        requested += 1;
        return fakeResponse(200);
      },
    });

    const seen = await drain(
      transport({
        endpoint: endpoint(),
        body: BODY,
        signal: controller.signal,
      }),
    );

    expect(seen).toEqual([]);
    expect(requested).toBe(0);
  });
});
