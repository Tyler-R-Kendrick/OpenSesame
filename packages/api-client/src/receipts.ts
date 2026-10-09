import type { BoundaryValue } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

export function receiptsApi(ctx: HostRequestContext) {
  return {
    async getReceipt(id: string): Promise<BoundaryValue> {
      return ctx.requestJson(
        "receipt",
        `/api/v1/receipts/${encodeURIComponent(id)}`,
      );
    },

    async verifyReceipt(id: string): Promise<BoundaryValue> {
      return ctx.requestJson(
        "receipt_verify",
        `/api/v1/receipts/${encodeURIComponent(id)}/verify`,
        { method: "POST" },
      );
    },

    /** Published public keys only — nothing secret is exposed. */
    async receiptKeys(): Promise<BoundaryValue> {
      return ctx.requestJson("receipt_keys", "/api/v1/receipts/keys");
    },
  };
}
