import {
  buildConsentReceipt,
  fixtureResolveInput,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import { expect, it, vi } from "vitest";
import { NATIVE_PROVIDER_PURPOSE } from "./catalog-always-on.js";
import { TAILSCALE_IDENTITY_HTTP_PURPOSE } from "./catalog-optional-services.js";
import { CAPABILITY_CATALOG, describeCapability } from "./catalog.js";
import { createEgressPort } from "./egress.js";

const capability = "networking.tailnet";
const meta = { capability, purpose: TAILSCALE_IDENTITY_HTTP_PURPOSE };
function approvedPlan(selected: boolean) {
  const input = fixtureResolveInput({
    catalog: CAPABILITY_CATALOG,
    installation: fixtureSelection({
      selectedOptional: selected ? [capability] : [],
    }),
  });
  const base = {
    ...input,
    distribution: {
      ...input.distribution,
      capabilityIds: CAPABILITY_CATALOG.capabilities.map((item) => item.id),
      moduleIds: CAPABILITY_CATALOG.capabilities.flatMap(
        (item) => item.moduleIds,
      ),
    },
  };
  const first = resolveComposition(base);
  const receipt = buildConsentReceipt(
    first,
    CAPABILITY_CATALOG,
    input.facts.now,
  );
  const plan = resolveComposition({ ...base, receipt });
  return {
    ...plan,
    network: {
      ...plan.network,
      allowedServiceOrigins: ["https://id.example.test"],
    },
  };
}
function fixture(selected = true) {
  const descriptor = describeCapability(capability);
  if (!descriptor) throw new Error("Networking descriptor is missing.");
  let plan = approvedPlan(selected);
  const fetchImpl = vi.fn<typeof fetch>();
  const port = createEgressPort({
    capability: descriptor,
    plan: () => plan,
    allowedOrigins: ["https://vault.example.test"],
    mayPairLocalAuthority: () => false,
    fetchImpl,
  });
  return {
    descriptor,
    port,
    fetchImpl,
    replace: (next: typeof plan) => {
      plan = next;
    },
  };
}
it("declares an explicit, nonautomatic native identity HTTPS purpose under Networking", () => {
  const f = fixture();
  expect(
    f.descriptor.egress.filter((entry) => entry.purpose === meta.purpose),
  ).toEqual([
    { class: "external-service", purpose: meta.purpose, automatic: false },
  ]);
  expect(f.port.decide("https://id.example.test/token", meta)).toMatchObject({
    ok: true,
    class: "external-service",
  });
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("does not borrow connector approval or permit undeclared purposes", () => {
  const f = fixture();
  expect(
    f.port.decide("https://id.example.test/token", {
      capability: "connectors.external",
      purpose: NATIVE_PROVIDER_PURPOSE,
    }),
  ).toMatchObject({ ok: false, code: "capability-mismatch" });
  expect(
    f.port.decide("https://id.example.test/token", {
      capability,
      purpose: NATIVE_PROVIDER_PURPOSE,
    }),
  ).toMatchObject({ ok: false, code: "purpose-not-declared" });
  expect(
    fixture(false).port.decide("https://id.example.test/token", meta),
  ).toMatchObject({ ok: false, code: "capability-not-approved" });
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it("retains exact origin, secure transport, local-authority and current-plan requirements", () => {
  const f = fixture();
  for (const [url, code] of [
    ["https://unapproved.example.test/token", "origin-not-allowed"],
    ["http://id.example.test/token", "unsupported-scheme"],
    ["https://127.0.0.1/token", "local-authority-not-permitted"],
  ])
    expect(f.port.decide(url, meta)).toMatchObject({ ok: false, code });
  f.replace({
    ...approvedPlan(true),
    network: { externalServices: "deny", allowedServiceOrigins: [] },
  });
  expect(f.port.decide("https://id.example.test/token", meta)).toMatchObject({
    ok: false,
    code: "external-services-denied",
  });
  f.replace(approvedPlan(false));
  expect(f.port.decide("https://id.example.test/token", meta)).toMatchObject({
    ok: false,
    code: "capability-not-approved",
  });
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
