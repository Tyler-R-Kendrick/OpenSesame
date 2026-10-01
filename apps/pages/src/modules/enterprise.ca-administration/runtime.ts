/**
 * `enterprise.ca-administration` — issuing certificates from the *Host's*
 * authority (`certs.issue`) and keeping them as certificate records.
 *
 * This module registers nothing, on purpose. Pages carries no Host
 * certificate-authority surface today: a repository-wide search for the
 * Host's certificate routes finds none, and the only certificate code in
 * `apps/pages` is `lib/certs.ts` — local, self-signed, WebCrypto issuance
 * from the item editor — which belongs to `vault.certificate-records` and
 * needs no Host at all. `tutorial/registry/capability-tutorials.ts` already
 * maps `certs.issue` onto the `vault.item.create` walkthrough for the same
 * reason.
 *
 * The module exists so the id is real: a managed instance can name
 * `enterprise.ca-administration` in its policy and prohibit it, the
 * distribution can exclude it, and the surface-parity sweep can see it. The
 * moment a Host issuance ceremony lands in Pages it goes here — behind
 * `ctx.egress` with the `external-service` class the descriptor declares
 * (the configured Host API's certificate routes, user-initiated) — and
 * nothing about the contract around it changes.
 *
 * Egress: none today. Side effects: none at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  type FeatureOperation,
  runListedFeature,
} from "@opensesame/app-core/lib/feature-connector-operation.js";
import { performSavedConnector } from "@opensesame/app-core/lib/feature-request-send.js";
import type { FeatureRequest } from "@opensesame/app-core/lib/feature-request.js";

import { applySavedConnectors } from "../../lib/apply-saved-connectors.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "enterprise.ca-administration";

/** Certificate connectors saved on this device. */
export function savedCertificateOperation(
  provider: Provider | string,
): FeatureOperation {
  return runListedFeature(provider);
}

export function applySavedCertificateConnectors(): FeatureOperation[] {
  return applySavedConnectors(["certificates"], savedCertificateOperation);
}

export function startCertificateConnectors(): FeatureRequest[] {
  return applySavedCertificateConnectors().map((operation) =>
    certificateOperation(operation.providerId),
  );
}

export function certificateOperation(providerId: string): FeatureRequest {
  return performSavedConnector(providerId);
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    startCertificateConnectors();
    return activation.handle();
  },
};
