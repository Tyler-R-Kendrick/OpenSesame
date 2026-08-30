import type { BoundaryValue } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

export interface ProjectChangelogQuery {
  limit?: number;
  beforeSeq?: number;
}

export function changelogApi(ctx: HostRequestContext) {
  return {
    /**
     * The changelog feed is project-scoped on the Host API
     * (`GET /api/v1/projects/{project_id}/changelog`); there is no
     * unscoped GET collection.
     */
    async projectChangelog(
      projectId: string,
      query?: ProjectChangelogQuery,
    ): Promise<BoundaryValue> {
      const params = new URLSearchParams();
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      if (query?.beforeSeq !== undefined) {
        params.set("before_seq", String(query.beforeSeq));
      }
      const qs = params.toString();
      return ctx.requestJson(
        "project_changelog",
        `/api/v1/projects/${encodeURIComponent(projectId)}/changelog${
          qs ? `?${qs}` : ""
        }`,
      );
    },
  };
}
