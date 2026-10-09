import type { BoundaryValue } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

/** Exactly one of connection_id or store_path names the rotation target. */
export interface CreateRotationRequest {
  connection_id?: string;
  store_path?: string;
  project_id?: string;
  interval?: string;
  execute_now?: boolean;
}

export function rotationsApi(ctx: HostRequestContext) {
  return {
    async listRotations(): Promise<BoundaryValue> {
      return ctx.requestJson("rotations", "/api/v1/rotations");
    },

    async createRotation(body: CreateRotationRequest): Promise<BoundaryValue> {
      return ctx.requestJson("rotation_create", "/api/v1/rotations", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async getRotation(id: string): Promise<BoundaryValue> {
      return ctx.requestJson(
        "rotation",
        `/api/v1/rotations/${encodeURIComponent(id)}`,
      );
    },

    async rotationPolicies(): Promise<BoundaryValue> {
      return ctx.requestJson("rotation_policies", "/api/v1/rotation/policies");
    },
  };
}
