/**
 * `sharing.trusted-contacts` — a circle of trusted contacts, and optionally a
 * quorum of them (ADR 0187). The behaviour lives in
 * `packages/app-core/src/lib/quorum/`: guardian policy, quorum approvals bound
 * to one request, SLIP-0039 shares, HPKE release, and the quorum-approved
 * standing share; the desk beside it (`quorum/desk/`) runs one ceremony step
 * at a time against the ports this module supplies (`use-desk.ts`). Everything
 * there is peer to peer: a contact approves with their own security key on
 * their own device, and nothing goes to a service.
 *
 * Contributed: Settings › Security › Trusted contacts — the owner's Circles —
 * and the walkthrough that points at it
 * (`tutorial/registry/trusted-contacts-catalog.ts`). The section has no
 * settings file: what it holds are vault records, not configuration
 * (ADR 0134, ADR 0158). Each panel says why instead of drawing a blank while
 * the vault is locked, a guest or a decoy.
 *
 * Egress: none. This module makes no request and holds no `ctx.egress` call.
 * An invitation, an enrollment, a request, an approval and a release are
 * packets (`quorum/packets.ts`) a person copies and hands to another person
 * over whatever road they already trust, and the recovery file is a file they
 * save and open. The capability declares the user-mediated hand-off, and two
 * browser permissions: `webauthn`, for the security keys that approve, and
 * `clipboard-write`, for the Copy key beside a packet.
 * Side effects: none at import, none on activation beyond the contributions.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  TRUSTED_CONTACTS_GOALS,
  TRUSTED_CONTACTS_ROUTES,
  TRUSTED_CONTACTS_TARGETS,
} from "@opensesame/app-core/tutorial/registry/trusted-contacts-catalog.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { TrustedContacts } from "./TrustedContacts.js";

export const CAPABILITY = "sharing.trusted-contacts";

export const TUTORIAL = {
  targets: TRUSTED_CONTACTS_TARGETS,
  goals: TRUSTED_CONTACTS_GOALS,
  routes: TRUSTED_CONTACTS_ROUTES,
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // A subsection of Security, not a top-level Settings destination: the
    // three panels are one place in the security story, beside duress and
    // travel, and the page index still lists it as Trusted contacts.
    activation.register("settings-panel", {
      id: "trusted-contacts",
      label: "Trusted contacts",
      category: "security",
      Panel: TrustedContacts,
      order: 330,
    });
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
