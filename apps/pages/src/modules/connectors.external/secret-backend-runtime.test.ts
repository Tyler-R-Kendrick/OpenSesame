import { approvedPlan } from "@opensesame/app-core/lib/capabilities/__tests__/plan-fixtures.js";
import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { describeCapability } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import { createSecretBackend } from "@opensesame/app-core/lib/secret-backends/factory.js";
import { secretBackendDraft } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { secretBackendTransport } from "@opensesame/app-core/lib/secret-backends/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindSecretBackendRuntime } from "./secret-backend-runtime.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  while (disposals.length) disposals.pop()?.();
  vi.restoreAllMocks();
});

function activate(
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  externalServices: "allow" | "deny" = "allow",
  mayPairLocalAuthority = false,
) {
  const descriptor = describeCapability("connectors.external");
  if (!descriptor) throw new Error("Missing connector descriptor");
  const plan = approvedPlan(["connectors.external"]);
  const currentPlan = {
    ...plan,
    network: {
      ...plan.network,
      externalServices,
      allowedServiceOrigins: ["https://secrets.example"],
    },
  };
  const egress = createEgressPort({
    capability: descriptor,
    plan: () => currentPlan,
    allowedOrigins: ["https://vault.example"],
    mayPairLocalAuthority: () => mayPairLocalAuthority,
    fetchImpl: fetcher,
  });
  const test = createTestContext();
  const ctx = { ...test.ctx, egress };
  const activation = createActivation(ctx, "connectors.external");
  bindSecretBackendRuntime(ctx, activation);
  disposals.push(activation.dispose);
  return { test, activation, currentPlan, egress };
}

const configuration = () => ({
  ...secretBackendDraft("infisical"),
  baseUrl: "https://secrets.example/mounted",
  token: "private-scoped-token",
  projectId: "project",
  environment: "dev",
  secretPath: "/",
});

describe("direct secret backend capability egress", () => {
  it.each(["lease", "dispose"])(
    "aborts the captured HTTP request and rejects late results after %s",
    async (disabled) => {
      let complete = (_response: Response) => {};
      const fetcher = vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      );
      const active = activate(fetcher);
      const request = secretBackendTransport().fetch(
        "https://secrets.example/slow",
      );
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const requestSignal = fetcher.mock.calls[0]?.[1]?.signal;
      if (disabled === "lease") active.test.abort();
      else active.activation.dispose();
      await expect(request).rejects.toMatchObject({ code: "stale" });
      expect(requestSignal?.aborted).toBe(true);
      complete(Response.json({ secrets: [] }));
      expect(() => secretBackendTransport()).toThrow();
    },
  );

  it("uses direct declared egress for real adapter requests without a bridge or global fetch replacement", async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ secrets: [] }),
    );
    const active = activate(fetcher);
    const spy = vi.spyOn(active.egress, "fetch");
    const backend = await createSecretBackend("infisical");
    await backend.authenticate(configuration());
    expect(spy.mock.calls[0]?.[2]).toEqual({
      capability: "connectors.external",
      purpose: NATIVE_PROVIDER_PURPOSE,
    });
    expect(fetcher.mock.calls[0]?.[0]).toContain(
      "https://secrets.example/mounted/api/v4/secrets?",
    );
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer private-scoped-token");
    expect(globalThis.fetch).toBe(original);
  });

  it("enforces current plan network denial and destination allowlists before any credential leaves", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ secrets: [] }),
    );
    const active = activate(fetcher);
    const transport = secretBackendTransport();
    active.currentPlan.network.externalServices = "deny";
    await expect(
      transport.fetch("https://secrets.example/api/v4/secrets"),
    ).rejects.toMatchObject({ code: "unsupported" });
    active.currentPlan.network.externalServices = "allow";
    await expect(
      transport.fetch("https://unexpected.example/collect", {
        headers: { authorization: "Bearer private-scoped-token" },
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses local operator authority when the deployment does not permit it", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ secrets: [] }),
    );
    activate(fetcher);
    await expect(
      secretBackendTransport().fetch("http://127.0.0.1:9876/api"),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("pins the authenticated backend base despite subsequent draft changes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ secrets: [] }),
    );
    activate(fetcher);
    const backend = await createSecretBackend("infisical");
    const draft = configuration();
    const session = await backend.authenticate(draft);
    draft.baseUrl = "https://unexpected.example/steal";
    await backend.listItems(session);
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(
      fetcher.mock.calls.every(([target]) =>
        String(target).startsWith(
          "https://secrets.example/mounted/api/v4/secrets?",
        ),
      ),
    ).toBe(true);
  });

  it("preserves POST Request headers, body and explicit caller overrides", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    activate(fetcher);
    await secretBackendTransport().fetch(
      new Request("https://secrets.example/mounted/login", {
        method: "POST",
        headers: { authorization: "Bearer old" },
        body: "old",
      }),
      { headers: { authorization: "Bearer replacement" }, body: "replacement" },
    );
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error("Expected the direct provider request");
    expect(call?.[1]?.method).toBe("POST");
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
      "Bearer replacement",
    );
    expect(await new Request(call[0], call[1]).text()).toBe("replacement");
  });
});
