/** @vitest-environment jsdom */
import { createBridgeClient } from "@opensesame/app-core/lib/connector-bridge-client.js";
import {
  bridgedFetch,
  nativeBridgeStore,
  resetNativeBridgeForTest,
} from "@opensesame/app-core/lib/native-bridge.js";
import {
  pageReplyMessage,
  parsePageRequest,
} from "@opensesame/connector-bridge";
import { afterEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindBridgeRuntime, windowChannel } from "./bridge-runtime.js";

const TOKEN_URL = "https://zoom.us/oauth/token";

afterEach(() => {
  resetNativeBridgeForTest();
});

it.each(["missing", "replaced"] as const)(
  "removes the actual Window listener after a delayed drain when its remover is %s",
  async (retirement) => {
    const frame = document.createElement("iframe");
    frame.src = window.location.href;
    document.body.append(frame);
    const target = frame.contentWindow;
    if (!target) throw new Error("A real child Window is required");
    expect(target.location.origin).toBe(window.location.origin);
    const original = Object.getOwnPropertyDescriptor(
      target,
      "removeEventListener",
    );
    const received = vi.fn();
    const replacement = vi.fn(() => {
      throw new Error("The retired Window remover must not be called");
    });
    const channel = windowChannel(target);
    vi.useFakeTimers();
    const client = createBridgeClient(
      {
        ...channel,
        listen(handler) {
          return channel.listen((data) => {
            received(data);
            handler(data);
          });
        },
      },
      { helloMs: 20 },
    );
    const send = (source: Window | null, origin: string) =>
      target.dispatchEvent(
        new MessageEvent("message", { data: "probe", source, origin }),
      );
    try {
      const pending = client.hello();
      client.drain();
      send(target, "https://unrelated.example");
      send(window, target.location.origin);
      send(null, target.location.origin);
      expect(received).not.toHaveBeenCalled();
      send(target, target.location.origin);
      expect(received).toHaveBeenCalledTimes(1);
      Object.defineProperty(target, "removeEventListener", {
        configurable: true,
        value: retirement === "missing" ? undefined : replacement,
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toBeNull();
      send(target, target.location.origin);
      expect(received).toHaveBeenCalledTimes(1);
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      if (original)
        Object.defineProperty(target, "removeEventListener", original);
      else Reflect.deleteProperty(target, "removeEventListener");
      client.close();
      vi.useRealTimers();
      frame.remove();
    }
  },
);

it("reads a request already sent when the activation disposes, instead of dropping it", async () => {
  const releaseFetch: Array<() => void> = [];
  const hear = (event: MessageEvent) => {
    const request = parsePageRequest(event.data);
    if (!request) return;
    const send = (reply: Parameters<typeof pageReplyMessage>[0]) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: pageReplyMessage(reply),
          source: window,
          origin: window.location.origin,
        }),
      );
    };
    if (request.op === "hello") {
      queueMicrotask(() =>
        send({
          id: request.id,
          result: {
            bridge: "opensesame-connector-bridge",
            version: "0.1.0",
            granted: ["zoom.us"],
          },
        }),
      );
      return;
    }
    if (request.op !== "fetch") return;
    releaseFetch.push(() =>
      send({
        id: request.id,
        result: {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: '{"access_token":"kept"}',
        },
      }),
    );
  };
  window.addEventListener("message", hear);
  const activation = createActivation(
    createTestContext().ctx,
    "connectors.external",
  );
  try {
    bindBridgeRuntime(activation);
    await vi.waitFor(() => {
      const snapshot = nativeBridgeStore.getSnapshot();
      expect(snapshot.present).toBe(true);
      expect(snapshot.granted).toContain("zoom.us");
    });
    const pending = bridgedFetch(TOKEN_URL, {
      method: "POST",
      body: "grant_type=authorization_code",
    });
    const settled = (async () => {
      try {
        return { ok: true as const, response: await pending };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    await vi.waitFor(() => expect(releaseFetch).toHaveLength(1));
    activation.dispose();
    releaseFetch[0]?.();
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;
    expect(await outcome.response.json()).toEqual({ access_token: "kept" });
  } finally {
    window.removeEventListener("message", hear);
    if (!activation.disposed()) activation.dispose();
  }
});
