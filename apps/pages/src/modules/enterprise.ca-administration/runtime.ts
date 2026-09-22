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

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "enterprise.ca-administration";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    return createActivation(ctx, CAPABILITY).handle();
  },
};
