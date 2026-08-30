import type { BoundaryValue } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

/** Attenuation-only edit (ADR 0046 decision 10) — widening is refused. */
export interface NarrowDelegationRequest {
  actions?: string[];
  resources?: string[];
  expires_in_seconds?: number;
}

export function delegationsApi(ctx: HostRequestContext) {
  return {
    async listDelegations(): Promise<BoundaryValue> {
      return ctx.requestJson("delegations", "/api/v1/delegations");
    },

    async listOffers(): Promise<BoundaryValue> {
      return ctx.requestJson("delegation_offers", "/api/v1/delegations/offers");
    },

    async narrowDelegation(
      id: string,
      body: NarrowDelegationRequest,
    ): Promise<BoundaryValue> {
      return ctx.requestJson(
        "delegation_narrow",
        `/api/v1/delegations/${encodeURIComponent(id)}/narrow`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },

    async revokeDelegation(id: string): Promise<BoundaryValue> {
      return ctx.requestJson(
        "delegation_revoke",
        `/api/v1/delegations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },

    async revokeOffer(id: string): Promise<BoundaryValue> {
      return ctx.requestJson(
        "delegation_offer_revoke",
        `/api/v1/delegations/offers/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
  };
}
