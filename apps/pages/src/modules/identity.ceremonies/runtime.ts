/**
 * `identity.ceremonies` — the routes a link opens on this origin (ADR 0140,
 * `spec/config/ceremony-routes.json`). Always-on: a link a device printed
 * must open on every installation, so there is no switch for it, but its
 * code still arrives as this module after boot.
 *
 * Today it carries `/device`: approving a device or CLI sign-in from its
 * user code. The older links that now open it (`?user_code=`, `?code=`,
 * `opensesame://invoke/mfa`, `opensesame-mfa://approve`) are normalised by
 * the core boot before the first paint (`app-core/lib/device-link.ts`), not
 * here: the address must be clean before anything renders, and boot may not
 * import a module to make it so.
 *
 * Egress: the configured Identity API's `POST /v1/device/approve` via
 * `identityFetch` (`app-core/lib/directory.ts` → ceremony-kit
 * `approveDevice`), when the person presses Approve and only with an
 * Identity session. Nothing at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
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

    return activation.handle();
  },
};
