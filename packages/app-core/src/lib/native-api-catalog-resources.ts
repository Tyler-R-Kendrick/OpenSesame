/** Provider catalogs compose the same closed request and bounded collection helpers. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import {
  jsonResource,
  projectResourceCollection,
  resourceId,
  resourceText,
} from "./native-api-resource.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const named = z.object({ id: resourceId, name: resourceText });
const sites = z.array(named).max(20);
const workspaces = z
  .array(z.object({ owner: named.extend({ type: z.enum(["user", "team"]) }) }))
  .max(20);
const sources = z.object({
  status: z.literal("ok"),
  sources: z.array(named),
  code: z.never().optional(),
  message: z.never().optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
});
const projects = z
  .array(
    z.object({
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      name: resourceText,
    }),
  )
  .max(20);
export function projectNetlifySites(body: BoundaryValue): BoundaryValue {
  return projectResourceCollection(
    sites.parse(body).map((site) => ({ id: site.id, label: site.name })),
    "sites",
    "first-page",
  );
}
export function projectRenderWorkspaces(body: BoundaryValue): BoundaryValue {
  return projectResourceCollection(
    workspaces
      .parse(body)
      .map(({ owner }) => ({ id: owner.id, label: owner.name })),
    "workspaces",
    "first-page",
  );
}
export function projectNewsSources(body: BoundaryValue): BoundaryValue {
  return projectResourceCollection(
    sources
      .parse(body)
      .sources.map((source) => ({ id: source.id, label: source.name })),
    "news sources",
    "returned",
  );
}
export function projectGitLabProjects(body: BoundaryValue): BoundaryValue {
  return projectResourceCollection(
    projects
      .parse(body)
      .map((project) => ({ id: String(project.id), label: project.name })),
    "membership projects",
    "first-page",
  );
}
const dovetail = z.object({
  data: z
    .array(
      z.object({
        id: resourceId,
        title: resourceText.or(z.literal("")),
        type: z.literal("project"),
        deleted: z.boolean(),
      }),
    )
    .max(20),
  page: z.object({
    total_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    has_more: z.boolean(),
    next_cursor: resourceText.nullable(),
  }),
  error: z.never().optional(),
  errors: z.never().optional(),
});
/** First page only: deleted projects and private content never reach the result. */
export function projectDovetailProjects(body: BoundaryValue): BoundaryValue {
  const response = dovetail.parse(body);
  if (
    response.page.total_count < response.data.length ||
    response.page.has_more !== (response.page.next_cursor !== null) ||
    new Set(response.data.map((project) => project.id)).size !==
      response.data.length
  )
    throw new NativeApiError("response");
  return projectResourceCollection(
    response.data
      .filter((project) => !project.deleted)
      .map((project) => ({
        id: project.id,
        label: project.title || "(Untitled project)",
      })),
    "active projects",
    "first-page",
  );
}
export const nativeCatalogResources = [
  jsonResource(
    "List projects",
    {
      providerId: "dovetail",
      operationId: "provider.projects.read",
      method: "GET",
      path: "/api/v1/projects",
      query: { "page[limit]": 20 },
    },
    projectDovetailProjects,
  ),
  jsonResource(
    "List sites",
    {
      providerId: "netlify",
      operationId: "provider.sites.read",
      method: "GET",
      path: "/api/v1/sites",
      query: { page: 1, per_page: 20 },
    },
    projectNetlifySites,
  ),
  jsonResource(
    "List workspaces",
    {
      providerId: "render",
      operationId: "provider.workspaces.read",
      method: "GET",
      path: "/v1/owners",
      query: { limit: 20 },
    },
    projectRenderWorkspaces,
  ),
  jsonResource(
    "List news sources",
    {
      providerId: "newsapi",
      operationId: "provider.sources.read",
      method: "GET",
      path: "/v2/top-headlines/sources",
    },
    projectNewsSources,
  ),
  jsonResource(
    "List membership projects",
    {
      providerId: "gitlab",
      operationId: "provider.projects.read",
      method: "GET",
      path: "/api/v4/projects",
      query: { membership: true, simple: true, per_page: 20, page: 1 },
    },
    projectGitLabProjects,
  ),
];
