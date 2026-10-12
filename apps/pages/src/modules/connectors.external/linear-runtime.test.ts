import { LINEAR_API_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import {
  linearApiSeams,
  verifyLinearAccount,
} from "@opensesame/app-core/lib/linear-api.js";
import { linearClientId } from "@opensesame/app-core/lib/linear-connectors.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindLinearRuntime } from "./linear-runtime.js";

const inactiveFetch = linearApiSeams.fetch;
afterEach(() => {
  linearApiSeams.fetch = inactiveFetch;
  vi.restoreAllMocks();
});

describe("Linear egress belongs to its active capability", () => {
  it.each(["lease", "dispose"])(
    "aborts pending provider HTTP on %s and rejects its late response",
    async (disable) => {
      const test = createTestContext({
        runtimeConfig: { linearClientId: "deployment-client" },
      });
      let resolveLate = (_response: Response) => {};
      const late = new Promise<Response>((resolve) => {
        resolveLate = resolve;
      });
      let requestSignal: AbortSignal | undefined;
      const fetcher = vi.fn<typeof test.ctx.egress.fetch>((_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return late;
      });
      const ctx = {
        ...test.ctx,
        egress: { ...test.ctx.egress, fetch: fetcher },
      };
      const activation = createActivation(ctx, "connectors.external");
      bindLinearRuntime(ctx, activation);
      const captured = linearApiSeams.fetch;
      const fulfilled = vi.fn();
      const inFlight = verifyLinearAccount({
        kind: "oauth",
        token: "private-token",
      });
      void inFlight.then(fulfilled, () => undefined);
      expect(fetcher).toHaveBeenCalledWith(
        "https://api.linear.app/graphql",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
        { capability: "connectors.external", purpose: LINEAR_API_PURPOSE },
      );
      expect(linearClientId()).toBe("deployment-client");
      expect(deviceProviderRevokers.linear).toBeTypeOf("function");
      if (disable === "lease") test.abort("disable");
      else activation.dispose();
      await expect(inFlight).rejects.toMatchObject({ code: "network" });
      expect(requestSignal?.aborted).toBe(true);
      expect(linearApiSeams.fetch).toBe(inactiveFetch);
      expect(linearClientId()).toBe("");
      expect(deviceProviderRevokers.linear).toBeUndefined();
      resolveLate(
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                id: "viewer",
                name: "Late viewer",
                email: "late@example.org",
              },
              organization: {
                id: "org",
                name: "Late organization",
                urlKey: "late",
              },
              teams: { nodes: [] },
            },
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(fulfilled).not.toHaveBeenCalled();
      await expect(
        captured("https://api.linear.app/graphql", {}),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      activation.dispose();
    },
  );

  it("forwards a caller's cancellation alongside the capability lease", async () => {
    const test = createTestContext();
    const controller = new AbortController();
    let forwarded: AbortSignal | undefined;
    const fetcher = vi.fn<typeof test.ctx.egress.fetch>(async (_url, init) => {
      forwarded = init?.signal ?? undefined;
      return new Response(null, { status: 204 });
    });
    const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch: fetcher } };
    const activation = createActivation(ctx, "connectors.external");
    bindLinearRuntime(ctx, activation);
    await linearApiSeams.fetch("https://api.linear.app/graphql", {
      signal: controller.signal,
    });
    expect(forwarded?.aborted).toBe(false);
    controller.abort();
    expect(forwarded?.aborted).toBe(true);
    activation.dispose();
  });

  it("starts no provider work for an already aborted lease", async () => {
    const test = createTestContext({
      runtimeConfig: { linearClientId: "client" },
    });
    test.abort("already-disabled");
    const activation = createActivation(test.ctx, "connectors.external");
    bindLinearRuntime(test.ctx, activation);
    await expect(
      verifyLinearAccount({ kind: "oauth", token: "private-token" }),
    ).rejects.toMatchObject({ code: "network" });
    expect(test.egressCalls).toEqual([]);
    expect(linearClientId()).toBe("");
    expect(deviceProviderRevokers.linear).toBeUndefined();
  });
});
