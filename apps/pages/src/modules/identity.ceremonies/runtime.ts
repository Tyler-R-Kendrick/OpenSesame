/**
 * `identity.ceremonies` — the routes a link opens on this origin (ADR 0140,
 * `spec/config/ceremony-routes.json`). Always-on: a link a device printed
 * must open on every installation, so there is no switch for it, but its
 * code still arrives as this module after boot.
 *
 * Today it carries:
 *
 *   - `/device`: approving a device or CLI sign-in from its user code. The
 *     older links that now open it (`?user_code=`, `?code=`,
 *     `opensesame://invoke/mfa`, `opensesame-mfa://approve`) are normalised
 *     by the core boot (`app-core/lib/device-link.ts`);
 *   - `/claim`: the claim-link dispatcher. An ownership claim is reviewed and
 *     accepted here, and a drop is opened here (the recipient's side of a
 *     drop is always-on, ADR 0140 D2; only sending one is `sharing.drops`,
 *     and this module imports none of that). The bearer and key leave the
 *     address in the core boot too (`app-core/lib/claims/arrival.ts`).
 *
 * Both are read at boot, not here: the address must be clean before anything
 * renders, and boot may not import a module to make it so.
 *
 * Neither touches the vault (ADR 0140 §2, D7): both are `gate: "any"`, read
 * no vault key, prompt no unlock and write nothing to OPFS. On a locked or
 * empty device they open by themselves, framed on their own page; in an
 * unlocked tab they open inside the shell. They need an Identity session,
 * never a vault — the Connect note (and, for a claim, the guest road) is on
 * the route itself.
 *
 * Egress: the configured Identity API via `identityFetch`, only when the
 * person acts — `POST /v1/device/approve` (`app-core/lib/directory.ts` →
 * ceremony-kit `approveDevice`), and the claim's `POST /v1/claims/present`,
 * `GET /v1/claims/{id}`, `POST /v1/claims/{id}/complete` and, for the guest
 * road, `POST /v1/principals/provisional` (`app-core/lib/claims/transport.ts`),
 * and a drop's `POST /v1/claims/present` with its user code
 * (`app-core/lib/claims/drop-open.ts`). Nothing at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { ClaimRoute } from "./ClaimRoute.js";
import { DeviceRoute } from "./DeviceRoute.js";

export const CAPABILITY = "identity.ceremonies";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // Before unlock (ADR 0140 §2): a link opens its ceremony, not the
    // unlock screen. The front door stays in front of every other path.
    activation.register("route", {
      id: "device",
      path: "/device",
      element: DeviceRoute,
      framed: true,
      order: 45,
      gate: "any",
    });
    activation.register("route", {
      id: "claim",
      path: "/claim",
      element: ClaimRoute,
      framed: true,
      order: 46,
      gate: "any",
    });

    return activation.handle();
  },
};
