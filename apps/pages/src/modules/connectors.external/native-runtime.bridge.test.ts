/** @vitest-environment jsdom */
import {
  nativeBridgeStore,
  resetNativeBridgeForTest,
} from "@opensesame/app-core/lib/native-bridge.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWindowBridge } from "../../sections/connections/connect/window-bridge.test-support.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  closeGenuineRuntimeFixture,
  genuineRuntimeFixture,
} from "./genuine-runtime.test-support.js";
import { bindNativeRuntime } from "./native-runtime.js";

const relays: { remove: () => void }[] = [];
beforeEach(genuineRuntimeFixture);
afterEach(async () => {
  await closeGenuineRuntimeFixture();
  for (const relay of relays.splice(0)) relay.remove();
  resetNativeBridgeForTest();
  vi.restoreAllMocks();
});

const TOKEN_BODY = "grant_type=authorization_code&code=fixture-code";
const exchange = () =>
  new Request("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      authorization: "Basic Zml4dHVyZTpzZWNyZXQ=",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: TOKEN_BODY,
  });

/** A registered OAuth application's token endpoint that refuses web pages (ADR 0218). */
describe("a token exchange at a host the bridge holds", () => {
  it.each(["fetch", "settleCredentialMutation"] as const)(
    "is carried by the bridge in %s, after the operator's egress decision, and never sent by the page",
    async (kind) => {
      const test = createTestContext();
      const decide = vi.spyOn(test.ctx.egress, "decide");
      const direct = vi.fn<typeof test.ctx.egress.fetch>(async () =>
        Response.json({ page: "must not be used" }),
      );
      const ctx = {
        ...test.ctx,
        egress: { ...test.ctx.egress, fetch: direct },
      };
      const relay = installWindowBridge({
        granted: ["zoom.us"],
        onFetch: () => ({
          status: 200,
          headers: [["content-type", "application/json"]],
          body: '{"access_token":"issued","token_type":"bearer","expires_in":3600}',
        }),
      });
      relays.push(relay);
      const activation = createActivation(ctx, "connectors.external");
      bindNativeRuntime(ctx, activation);
      // The page finds the bridge when its window is looked at again.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await vi.waitFor(() =>
        expect(nativeBridgeStore.getSnapshot().present).toBe(true),
      );
      const send = nativeProviderTransport()[kind];
      if (!send) throw new Error("Missing transport fixture");
      try {
        const response = await send(exchange());
        expect(await response.json()).toMatchObject({ access_token: "issued" });
        const fetched = relay.heard.flatMap((request) =>
          request.op === "fetch" ? [request.request] : [],
        );
        expect(fetched).toHaveLength(1);
        expect(fetched[0]).toMatchObject({
          providerId: "zoom",
          url: "https://zoom.us/oauth/token",
          method: "POST",
          body: TOKEN_BODY,
        });
        expect(fetched[0]?.headers).toContainEqual([
          "authorization",
          "Basic Zml4dHVyZTpzZWNyZXQ=",
        ]);
        expect(direct).not.toHaveBeenCalled();
        expect(decide).toHaveBeenCalled();
      } finally {
        activation.dispose();
      }
    },
  );

  it.each(["fetch", "settleCredentialMutation"] as const)(
    "stays a direct call in %s when the bridge does not hold the host",
    async (kind) => {
      const test = createTestContext();
      const direct = vi.fn<typeof test.ctx.egress.fetch>(async () =>
        Response.json({ access_token: "direct" }),
      );
      const ctx = {
        ...test.ctx,
        egress: { ...test.ctx.egress, fetch: direct },
      };
      const relay = installWindowBridge({ granted: ["api.zoom.us"] });
      relays.push(relay);
      const activation = createActivation(ctx, "connectors.external");
      bindNativeRuntime(ctx, activation);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await vi.waitFor(() =>
        expect(nativeBridgeStore.getSnapshot().present).toBe(true),
      );
      const send = nativeProviderTransport()[kind];
      if (!send) throw new Error("Missing transport fixture");
      try {
        await send(exchange());
        expect(direct).toHaveBeenCalledTimes(1);
        expect(relay.heard.some((request) => request.op === "fetch")).toBe(
          false,
        );
      } finally {
        activation.dispose();
      }
    },
  );
});
