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
 *     address in the core boot too (`app-core/lib/claims/arrival.ts`);
 *   - `/i/:ref`: the phone half of a cross-device approval (ADR 0086), from
 *     `apps/mobile-mfa`: resolve, read, approve with a passkey touch bound
 *     to this request, or deny;
 *   - `/approve/:ref`: the authorization-request review (ADR 0084), from
 *     `apps/ceremonies`: request, requirement, an activation bound to the
 *     digest, the verb and the policy shown, decide or report. Access ›
 *     Requests' hosted rows open it; nothing there approves inline;
 *   - `/invoke/:kind`: the authenticator hand-off, from `apps/ceremonies`:
 *     the native app link ceremony-kit builds for an MFA user code or
 *     request id, or a wallet protocol's request URI, and for a user code
 *     the `/device` ceremony as its fallback. It calls nothing, and never
 *     fetches a request URI or a credential offer.
 *
 * Every link is read at boot, not here: the address must be clean before
 * anything renders, and boot may not import a module to make it so
 * (`device-link.ts`, `claims/arrival.ts`, `interactions-link.ts`,
 * `approvals-link.ts`, `invoke-link.ts`). The `/i`, `/approve` and `/invoke`
 * screens load only when their route opens (`lazy-routes.tsx`).
 *
 * None touches the vault (ADR 0140 §2, D7): all are `gate: "any"`, read no
 * vault key, prompt no unlock and write nothing to OPFS. On a locked or
 * empty device they open by themselves, framed on their own page; in an
 * unlocked tab they open inside the shell. They need an Identity session,
 * never a vault — the Connect note (and, for a claim, the guest road) is on
 * the route itself. `/i` and `/approve` ask for a passkey (`webauthn`).
 *
 * Egress: the configured Identity API via `identityFetch`, only when the
 * person acts — `POST /v1/device/approve` (`app-core/lib/directory.ts` →
 * ceremony-kit `approveDevice`), and the claim's `POST /v1/claims/present`,
 * `GET /v1/claims/{id}`, `POST /v1/claims/{id}/complete` and, for the guest
 * road, `POST /v1/principals/provisional` (`app-core/lib/claims/transport.ts`),
 * and a drop's `POST /v1/claims/present` with its user code
 * (`app-core/lib/claims/drop-open.ts`); an interaction's `GET /i/{ref}` (no
 * session, no cookie), `GET /v1/interactions/{ref}` and its `activation`,
 * `activation/complete`, `approve` and `deny` (`app-core/lib/interactions.ts`);
 * a review's `GET /v1/authorization-requests/{id}` and `…/requirement`,
 * `activation`, `activation/complete`, `approve`, `deny` and `report`
 * (`app-core/lib/approvals.ts`). An `/i` or `/approve` route loads its
 * reference on arrival; nothing at import.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { ClaimRoute } from "./ClaimRoute.js";
import { DeviceRoute } from "./DeviceRoute.js";
import { ApproveRoute, InteractionRoute, InvokeRoute } from "./lazy-routes.js";

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
    activation.register("route", {
      id: "interaction",
      path: "/i/:ref",
      element: InteractionRoute,
      framed: true,
      order: 47,
      gate: "any",
    });
    activation.register("route", {
      id: "approve",
      path: "/approve/:ref",
      element: ApproveRoute,
      framed: true,
      order: 48,
      gate: "any",
    });
    activation.register("route", {
      id: "invoke",
      path: "/invoke/:kind",
      element: InvokeRoute,
      framed: true,
      order: 49,
      gate: "any",
    });

    return activation.handle();
  },
};
