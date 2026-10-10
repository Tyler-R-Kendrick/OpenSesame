/**
 * `sharing.trusted-contacts` — a circle of trusted contacts, and optionally a
 * quorum of them (ADR 0186). The behaviour lives in
 * `packages/app-core/src/lib/quorum/`: guardian policy, quorum approvals bound
 * to one request, SLIP-0039 shares, HPKE release, and the quorum-approved
 * standing share. Everything there is peer to peer: a contact approves with
 * their own security key on their own device, and nothing goes to a service.
 *
 * This module has no surface of its own yet. The ceremonies — invite a
 * contact, take a share, approve a request — need screens that meet the
 * keyboard, touch and tutorial contracts, and they are a change of their own.
 * Until they exist Settings draws no switch for it (`NO_SURFACE` in
 * `lib/capabilities/feature-surface.ts`, ADR 0158): a switch whose module
 * registers nothing would promise a circle nobody can form. The capability is
 * here so an operator can name it in a policy, prohibit it, or leave it out of
 * a distribution; when the screens land, register them here and take the id
 * out of `NO_SURFACE`.
 *
 * Egress: none. A request, an approval and a release are packets a person
 * hands on over whatever road they already use.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "sharing.trusted-contacts";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    return createActivation(ctx, CAPABILITY).handle();
  },
};
