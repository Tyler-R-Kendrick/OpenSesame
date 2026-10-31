/** @vitest-environment jsdom */
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
import { bindBridgeRuntime } from "./bridge-runtime.js";

const TOKEN_URL = "https://zoom.us/oauth/token";

afterEach(() => {
  resetNativeBridgeForTest();
});

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
    const settled = pending.then(
      (response) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error }),
    );
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
