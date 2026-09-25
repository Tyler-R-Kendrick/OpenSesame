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
 *     accepted here; a drop is handed to the opener `sharing.drops`
 *     contributes, when that capability is approved — this module imports
 *     none of its code. The bearer and key leave the address in the core
 *     boot too (`app-core/lib/claims/arrival.ts`).
 *
 * Both are read at boot, not here: the address must be clean before anything
 * renders, and boot may not import a module to make it so.
 *
 * Egress: the configured Identity API via `identityFetch`, only when the
 * person acts — `POST /v1/device/approve` (`app-core/lib/directory.ts` →
 * ceremony-kit `approveDevice`), and the claim's `POST /v1/claims/present`,
 * `GET /v1/claims/{id}`, `POST /v1/claims/{id}/complete` and, for the guest
 * road, `POST /v1/principals/provisional` (`app-core/lib/claims/transport.ts`).
 * Nothing at import.
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

    // Behind unlock like any section: the notifications tray a failure is
    // reported in lives in the shell, and an Identity session is held by an
    // unlocked tab. A locked device shows its sign-in and guest roads first.
    activation.register("route", {
      id: "device",
      path: "/device",
      element: DeviceRoute,
      framed: true,
      order: 45,
    });
    activation.register("route", {
      id: "claim",
      path: "/claim",
      element: ClaimRoute,
      framed: true,
      order: 46,
    });

    return activation.handle();
  },
};
