import type { BoundaryValue } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

export interface IssueCertRequest {
  common_name: string;
  dns_names?: string[];
  ip_addrs?: string[];
  ttl_hours?: number;
  issuer_connection_id?: string;
}

export function certsApi(ctx: HostRequestContext) {
  return {
    async listCerts(): Promise<BoundaryValue> {
      return ctx.requestJson("certs", "/api/v1/certs");
    },

    /**
     * Issuance delivers key material to the calling device; agent surfaces
     * must not relay it (the registry withholds certs.issue from WebMCP).
     */
    async issueCert(body: IssueCertRequest): Promise<BoundaryValue> {
      return ctx.requestJson("cert_issue", "/api/v1/certs/issue", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async certCa(): Promise<BoundaryValue> {
      return ctx.requestJson("cert_ca", "/api/v1/certs/ca");
    },
  };
}
