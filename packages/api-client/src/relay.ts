import type { BoundaryValue } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

export function relayApi(ctx: HostRequestContext) {
  return {
    async listPendingRelayRequests(): Promise<BoundaryValue> {
      return ctx.requestJson(
        "relay_requests_pending",
        "/api/v1/relay/requests/pending",
      );
    },

    async getRelayRequest(id: string): Promise<BoundaryValue> {
      return ctx.requestJson(
        "relay_request",
        `/api/v1/relay/requests/${encodeURIComponent(id)}`,
      );
    },
  };
}
