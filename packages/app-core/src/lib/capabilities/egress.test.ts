import type { EffectivePlan } from "@opensesame/capability-composition";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAMILY_POLICY,
  MANAGED_POLICY,
  approvedPlan,
  descriptorOf,
} from "./__tests__/plan-fixtures.js";
import { egressSeams } from "./egress-default.js";
import {
  EgressDenied,
  createEgressPort,
  installPlanAwareEgress,
  redactUrl,
} from "./egress.js";

const SELF = "https://vault.example.test";
const CONNECTORS = "connectors.external";
const CONNECTOR_PURPOSE = "the connector directory";
const LOCAL = "sharing.local-transport";
const LOCAL_PURPOSE = "nearby devices";

function fetchOk() {
  return vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
}

function port(
  capability: string,
  plan: EffectivePlan,
  fetchImpl = fetchOk(),
  mayPairLocalAuthority = () => true,
) {
  return {
    fetchImpl,
    port: createEgressPort({
      capability: descriptorOf(capability),
      plan: () => plan,
      allowedOrigins: [SELF],
      mayPairLocalAuthority,
      fetchImpl,
    }),
  };
}

async function denial(promise: Promise<Response>): Promise<string> {
  try {
    await promise;
    return "allowed";
  } catch (thrown) {
    return thrown instanceof EgressDenied ? thrown.code : "other";
  }
}

describe("createEgressPort (S18)", () => {
  it("NET-01: application assets are same-origin only", async () => {
    const plan = approvedPlan([CONNECTORS], FAMILY_POLICY);
    const { port: p, fetchImpl } = port(CONNECTORS, plan);
    const response = await p.fetch("/OpenSesame/assets/x.js", undefined, {
      capability: CONNECTORS,
      purpose: "",
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${SELF}/OpenSesame/assets/x.js`,
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(
      await denial(
        p.fetch("https://cdn.example.test/x.js", undefined, {
          class: "application-assets",
        }),
      ),
    ).toBe("not-same-origin");
  });

  it("NET-02: external services need the declaration, the plan's allow, and a listed origin", async () => {
    const plan = approvedPlan([CONNECTORS], FAMILY_POLICY);
    expect(plan.network).toEqual(FAMILY_POLICY.network);
    const { port: p, fetchImpl } = port(CONNECTORS, plan);
    const meta = { capability: CONNECTORS, purpose: CONNECTOR_PURPOSE };
    await p.fetch(
      "https://id.example.test/v1/connectors?page=2",
      { headers: { Authorization: "Bearer t" } },
      meta,
    );
    const [href, init] = fetchImpl.mock.calls[0] ?? ["", undefined];
    expect(href).toBe("https://id.example.test/v1/connectors?page=2");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
    expect(
      await denial(p.fetch("https://other.example.test/v1", undefined, meta)),
    ).toBe("origin-not-allowed");
    expect(
      await denial(p.fetch("http://id.example.test/v1", undefined, meta)),
    ).toBe("unsupported-scheme");
    expect(
      await denial(
        p.fetch("https://id.example.test/v1", undefined, {
          ...meta,
          purpose: "something else",
        }),
      ),
    ).toBe("purpose-not-declared");
    expect(
      await denial(
        p.fetch("https://id.example.test/v1", undefined, {
          capability: "vault.passwords",
          purpose: CONNECTOR_PURPOSE,
        }),
      ),
    ).toBe("capability-mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("NET-02: a plan that denies external services refuses even a declared purpose", async () => {
    const plan = approvedPlan([CONNECTORS], MANAGED_POLICY);
    expect(plan.capabilities[CONNECTORS]?.approved).toBe(true);
    const { port: p, fetchImpl } = port(CONNECTORS, plan);
    const outcome = await denial(
      p.fetch(
        "https://id.example.test/v1",
        { headers: { Authorization: "Bearer t" } },
        {
          capability: CONNECTORS,
          purpose: CONNECTOR_PURPOSE,
        },
      ),
    );
    expect(outcome).toBe("external-services-denied");
    // NET-05: nothing left, so the bearer never did.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("NET-03: peer or local network needs the deployment profile's permission", async () => {
    const plan = approvedPlan([LOCAL]);
    expect(plan.capabilities[LOCAL]?.approved).toBe(true);
    const meta = { capability: LOCAL, purpose: LOCAL_PURPOSE };
    const allowed = port(LOCAL, plan, fetchOk(), () => true);
    await allowed.port.fetch("http://192.168.1.20:18790/pair", undefined, meta);
    expect(allowed.fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      await denial(
        allowed.port.fetch("https://public.example.test/pair", undefined, meta),
      ),
    ).toBe("not-local-network");
    const refused = port(LOCAL, plan, fetchOk(), () => false);
    expect(
      await denial(
        refused.port.fetch("http://192.168.1.20:18790/pair", undefined, meta),
      ),
    ).toBe("local-authority-not-permitted");
    expect(refused.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a capability the plan did not approve, whatever the destination", async () => {
    const plan = approvedPlan([], FAMILY_POLICY);
    const { port: p, fetchImpl } = port(CONNECTORS, plan);
    expect(
      await denial(
        p.fetch("/same-origin.json", undefined, {
          capability: CONNECTORS,
          purpose: "",
        }),
      ),
    ).toBe("capability-not-approved");
    expect(fetchImpl).not.toHaveBeenCalled();
    // A live plan read: revocation takes effect on the next request.
    let current = approvedPlan([CONNECTORS], FAMILY_POLICY);
    const live = createEgressPort({
      capability: descriptorOf(CONNECTORS),
      plan: () => current,
      allowedOrigins: [SELF],
      fetchImpl: fetchOk(),
    });
    expect(live.decide("/x").ok).toBe(true);
    current = plan;
    expect(live.decide("/x")).toMatchObject({
      ok: false,
      code: "capability-not-approved",
    });
  });

  it("NET-04: a redirect is never followed, wherever it points", async () => {
    const plan = approvedPlan([CONNECTORS], FAMILY_POLICY);
    const redirecting = vi.fn<typeof fetch>(async () =>
      Response.redirect("https://evil.example.test/", 302),
    );
    const { port: p } = port(CONNECTORS, plan, redirecting);
    expect(
      await denial(
        p.fetch(
          "https://id.example.test/v1",
          { redirect: "follow" },
          { capability: CONNECTORS, purpose: CONNECTOR_PURPOSE },
        ),
      ),
    ).toBe("redirect-refused");
    const [, init] = redirecting.mock.calls[0] ?? ["", undefined];
    expect(init?.redirect).toBe("manual");
  });

  it("navigation targets, bad URLs and odd schemes are not fetchable", async () => {
    const plan = approvedPlan([CONNECTORS], FAMILY_POLICY);
    const { port: p } = port(CONNECTORS, plan);
    expect(
      await denial(
        p.fetch("https://github.com/login", undefined, {
          class: "user-mediated-navigation",
        }),
      ),
    ).toBe("navigation-not-fetchable");
    expect(
      await denial(
        p.fetch("http://[", undefined, { capability: CONNECTORS, purpose: "" }),
      ),
    ).toBe("invalid-url");
    expect(
      await denial(
        p.fetch("ftp://id.example.test/x", undefined, {
          capability: CONNECTORS,
          purpose: "",
        }),
      ),
    ).toBe("unsupported-scheme");
  });

  it("never writes a query string into an error or a decision", async () => {
    expect(redactUrl("https://id.example.test/v1/token?code=SECRET#frag")).toBe(
      "https://id.example.test/v1/token",
    );
    expect(redactUrl("https://user:pw@id.example.test/p?x=1")).toBe(
      "https://id.example.test/p",
    );
    expect(redactUrl("not a url")).toBe("<invalid-url>");
    const plan = approvedPlan([CONNECTORS], MANAGED_POLICY);
    const { port: p } = port(CONNECTORS, plan);
    let refusal: EgressDenied | null = null;
    try {
      await p.fetch("https://id.example.test/v1/token?code=SECRET", undefined, {
        capability: CONNECTORS,
        purpose: CONNECTOR_PURPOSE,
      });
    } catch (thrown) {
      if (thrown instanceof EgressDenied) refusal = thrown;
    }
    expect(refusal).toBeInstanceOf(EgressDenied);
    expect(refusal?.message).not.toContain("SECRET");
    expect(refusal?.destination).toBe("https://id.example.test/v1/token");
    const decision = p.decide("https://id.example.test/v1/token?code=SECRET");
    expect(JSON.stringify(decision)).not.toContain("SECRET");
  });
});

describe("installPlanAwareEgress (S18)", () => {
  const original = egressSeams.createEgressPort;
  afterEach(() => {
    egressSeams.createEgressPort = original;
  });

  it("hands modules a port bound to the live plan, and refuses before there is one", async () => {
    installPlanAwareEgress(SELF, fetchOk());
    const p = egressSeams.createEgressPort(CONNECTORS);
    expect(p.capability).toBe(CONNECTORS);
    // The store has not booted, so there is no plan and nothing may leave.
    expect(p.decide("/x")).toMatchObject({
      ok: false,
      code: "capability-not-approved",
    });
    expect(
      await denial(
        p.fetch("/x", undefined, { capability: CONNECTORS, purpose: "" }),
      ),
    ).toBe("capability-not-approved");
  });

  it("refuses a capability the catalog does not know rather than inventing a port", () => {
    installPlanAwareEgress(SELF, fetchOk());
    expect(() => egressSeams.createEgressPort("not.a-capability")).toThrow(
      EgressDenied,
    );
  });
});
