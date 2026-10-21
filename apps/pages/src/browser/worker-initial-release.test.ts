import { MessageChannel, MessagePort } from "node:worker_threads";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify } from "../lib/capabilities/classification.js";
import { createInitialWorkerReleaseProof } from "./worker-initial-release.js";

const SCOPE = "https://example.test/OpenSesame/";
const ENTRY = `${SCOPE}assets/main-AbCd1234.js`;
const channels: MessageChannel[] = [];
const peers: MessagePort[] = [];
const requests: JsonObject[] = [];

beforeEach(() => {
  channels.length = peers.length = requests.length = 0;
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("navigator", { serviceWorker: { controller: null } });
  vi.stubGlobal("location", new URL(SCOPE));
  vi.stubGlobal(
    "MessageChannel",
    class extends MessageChannel {
      constructor() {
        super();
        channels.push(this);
      }
    },
  );
});
afterEach(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  for (const peer of peers) peer.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function worker(
  reply: (message: JsonObject, port: MessagePort) => void,
  scriptURL = `${SCOPE}sw.js`,
): ServiceWorker {
  return overlapCast({
    scriptURL,
    postMessage(message: JsonObject, transfer: Transferable[]) {
      const port = transfer[0];
      if (!(port instanceof MessagePort))
        throw Error("Expected real transferred MessagePort");
      requests.push(message);
      peers.push(port);
      reply(message, port);
    },
  });
}

function response(message: JsonObject): JsonObject {
  return {
    type: "WORKER_INFO",
    releaseId: "rel-1",
    variant: "core-only",
    scopePath: "/OpenSesame/",
    pageModuleUrl: ENTRY,
    proofNonce: message.proofNonce,
  };
}

function proof() {
  const value = createInitialWorkerReleaseProof(ENTRY, SCOPE);
  if (!value) throw Error("Expected eligible initial entry");
  return value;
}

describe("initial executing-entry private port proof", () => {
  it("retains existing core browser-port ownership without classification exceptions", () => {
    expect(classify("src/browser/worker-initial-release.ts")).toMatchObject({
      classification: "core",
      capability: null,
    });
    expect(
      classify("src/browser/worker-initial-release.test.ts"),
    ).toMatchObject({ classification: "core", capability: null });
  });
  it("uses real MessageChannel and a fresh CSPRNG nonce, retaining the worker receiver", async () => {
    const closed = vi.spyOn(MessagePort.prototype, "close");
    const original = worker((message, port) =>
      port.postMessage(response(message)),
    );
    const post = vi.spyOn(original, "postMessage");
    expect(await proof()(original, new AbortController().signal)).toBe("rel-1");
    expect(await proof()(original, new AbortController().signal)).toBe("rel-1");
    expect(post.mock.contexts).toEqual([original, original]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.type).toBe("WORKER_HELLO");
      expect(request.pageModuleUrl).toBe(ENTRY);
      expect(request.proofNonce).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(requests[0]?.proofNonce).not.toBe(requests[1]?.proofNonce);
    expect(closed).toHaveBeenCalledTimes(4);
  });

  it.each([
    { proofNonce: "wrong" },
    { pageModuleUrl: `${SCOPE}assets/main-Old12345.js` },
    { scopePath: "/other/" },
    { variant: "push" },
    { releaseId: "bad:release" },
    { type: "OTHER" },
  ])("rejects a real-port response with wrong binding %j", async (wrong) => {
    const closed = vi.spyOn(MessagePort.prototype, "close");
    expect(
      await proof()(
        worker((message, port) =>
          port.postMessage({ ...response(message), ...wrong }),
        ),
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("rejects and closes an unexpected transferred reply port", async () => {
    const extra = new MessageChannel();
    channels.push(extra);
    expect(
      await proof()(
        worker((message, port) => {
          port.postMessage(response(message), [extra.port2]);
        }),
        new AbortController().signal,
      ),
    ).toBeNull();
  });

  it("does not accept a reply on the wrong port and closes on original-owner abort", async () => {
    const controller = new AbortController();
    let settled = false;
    const pending = proof()(
      worker((message) => {
        const unrelated = new MessageChannel();
        channels.push(unrelated);
        unrelated.port2.postMessage(response(message));
      }),
      controller.signal,
    ).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const closed = vi.spyOn(MessagePort.prototype, "close");
    controller.abort();
    expect(await pending).toBeNull();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("closes both real ports when the original worker refuses postMessage", async () => {
    const closed = vi.spyOn(MessagePort.prototype, "close");
    expect(
      await proof()(
        worker(() => {
          throw Error("original worker gone");
        }),
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it.each(["isSecureContext", "crossOriginIsolated"])(
    "requires initial %s",
    (name) => {
      vi.stubGlobal(name, false);
      expect(createInitialWorkerReleaseProof(ENTRY, SCOPE)).toBeNull();
    },
  );

  it("does not use this proof for an already controlled page", () => {
    vi.stubGlobal("navigator", {
      serviceWorker: { controller: worker(() => undefined) },
    });
    expect(createInitialWorkerReleaseProof(ENTRY, SCOPE)).toBeNull();
  });

  it.each([
    `${SCOPE}assets/another-AbCd1234.js`,
    `${SCOPE}assets/main-AbCd1234.js?latest=1`,
    "https://other.test/OpenSesame/assets/main-AbCd1234.js",
    "https://example.test/other/assets/main-AbCd1234.js",
  ])(
    "refuses an entry outside the actual immutable main contract %s",
    (url) => {
      expect(createInitialWorkerReleaseProof(url, SCOPE)).toBeNull();
    },
  );

  it("refuses a foreign claiming worker without opening any port", async () => {
    expect(
      await proof()(
        worker(() => undefined, "https://other.test/sw.js"),
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(channels).toHaveLength(0);
  });
});
