/**
 * `identity.siop` — answer a SIOPv2 request from a registered local
 * application with a self-issued token, gated on a passkey identity
 * (`lib/siop-authority.ts`, `lib/siop-keys.ts`). The authorize screen is
 * the whole surface: `/identity/siop`, behind the vault gate exactly as
 * `App.tsx` served it, because the response is signed with a key sealed in
 * the tomb.
 *
 * `@opensesame/siop-v2` is reachable only through this module.
 *
 * Egress: the fragment redirect back to the requesting application
 * (`user-mediated-navigation`), started by the person's approval. Nothing
 * here calls a network endpoint: the issuer is this origin and the
 * application is a local record.
 *
 * Side effects: none at import. The screen reads the request on mount and
 * the key pair is derived inside the ceremony.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { SiopAuthorize } from "../../screens/SiopAuthorize.js";
import { IDENTITY_GOALS } from "../../tutorial/registry/identity-goals.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { pickById } from "../tutorial-pick-b.js";

export const CAPABILITY = "identity.siop";

export const TUTORIAL = {
  goals: pickById(IDENTITY_GOALS, ["identity.local.siop.authorize"]),
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("route", {
      id: "identity-siop",
      path: "/identity/siop",
      element: SiopAuthorize,
      framed: true,
      order: 42,
    });
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
