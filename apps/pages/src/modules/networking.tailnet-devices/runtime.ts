/**
 * `networking.tailnet-devices` — managing the tailnet's real machines from
 * Identity › Devices (ADR 0166). Optional, default off, a dependency of
 * nothing and dependent on `networking.tailnet`: nothing of it reaches the
 * page before the plan approved it and a consent receipt covered it.
 *
 * Contributed: the Tailnet devices, Auth keys and Activity panels, put into
 * Identity › Devices through its slot (`sections/identity/tailnet-devices-slot.ts`)
 * so the always-on section imports none of this code.
 *
 * Egress this module makes, all through `ctx.egress` to the one daemon a
 * person paired this page with (`opensesame daemon tailnet pair`), and only
 * once the panel is drawn with a pairing in the open vault:
 * `GET /v1/tailnet/{status,devices,keys,audit}`, and on a person's key press
 * one of `POST /v1/tailnet/devices/{id}/{authorized,name,tags,key-expiry,
 * expire,routes}`, `DELETE /v1/tailnet/devices/{id}`, `POST /v1/tailnet/keys`,
 * `DELETE /v1/tailnet/keys/{id}`. Pairing: one `POST /v1/tailnet/pairing` to
 * the daemon the code names; forgetting: one `DELETE /v1/tailnet/pairing`.
 * The Tailscale credential never reaches this page; the daemon holds it.
 * Side effects: none at import, none on activation beyond the contribution.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { tailnetAdmin } from "@opensesame/app-core/lib/tailnet-admin/client.js";
import { createElement } from "react";
import { contributeTailnetDevices } from "../../sections/identity/tailnet-devices-slot.js";
import { createActivation } from "../activation.js";
import { TailnetDevices } from "./TailnetDevices.js";

export const CAPABILITY = "networking.tailnet-devices";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    const admin = tailnetAdmin(ctx.egress, CAPABILITY);
    const Panels = () => createElement(TailnetDevices, { admin });
    activation.onDispose(contributeTailnetDevices(Panels));
    return activation.handle();
  },
};
