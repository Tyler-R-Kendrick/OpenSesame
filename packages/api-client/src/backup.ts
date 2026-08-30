import type { BoundaryValue } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

export function backupApi(ctx: HostRequestContext) {
  return {
    async getBackupTarget(): Promise<BoundaryValue> {
      return ctx.requestJson("backup_target", "/api/v1/backup/target");
    },
  };
}
