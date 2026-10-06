import {
  type EffectivePlan,
  buildConsentReceipt,
  fixtureResolveInput,
  resolveComposition,
} from "@opensesame/capability-composition";
import { vi } from "vitest";
import { CAPABILITY_CATALOG } from "../capabilities/catalog.js";
import { compositionStore } from "../capabilities/store.js";
export function observationPlan(): EffectivePlan {
  const input = fixtureResolveInput({
    catalog: CAPABILITY_CATALOG,
    distribution: {
      distributionId: "observation-test",
      mode: "selective",
      capabilityIds: CAPABILITY_CATALOG.capabilities.map((d) => d.id),
      moduleIds: CAPABILITY_CATALOG.capabilities.flatMap((d) => d.moduleIds),
      workerVariants: [{ id: "core-only", scriptPath: "sw.js", satisfies: [] }],
      basePath: "/",
    },
  });
  const first = resolveComposition(input);
  return resolveComposition({
    ...input,
    receipt: buildConsentReceipt(
      first,
      CAPABILITY_CATALOG,
      new Date().toISOString(),
    ),
  });
}
/** Only the snapshot source is doubled; the real composition resolver and egress decision execute. */
export function installObservationPlan() {
  const snapshot = compositionStore.getSnapshot();
  let plan: EffectivePlan | null = observationPlan();
  const spy = vi
    .spyOn(compositionStore, "getSnapshot")
    .mockImplementation(() => ({ ...snapshot, plan }));
  return {
    set(next: EffectivePlan | null) {
      plan = next;
    },
    restore: () => spy.mockRestore(),
  };
}

/** Actual loopback development host policy, rather than an egress success hook. */
export const observationHostProfile = {
  securityProfile: {
    version: 1 as const,
    profile: "loopback_development" as const,
    canonicalOrigin: "http://127.0.0.1:18791",
    headerSecurity: false,
  },
  page: {
    location: Object.assign(new URL("http://127.0.0.1:18791"), {
      assign: () => {},
      replace: () => {},
      reload: () => {},
    }),
    opener: null,
    isSecureContext: true,
    visibilityState: "visible" as const,
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => null,
    close: () => {},
    replaceUrl: () => {},
    onVisibilityChange: () => () => {},
    startDownload: () => {},
    submitForm: () => {},
  },
};
