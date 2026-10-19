/** Small partner schemas compose the shared closed request and collection surface. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  jsonResource,
  projectResourceCollection,
  resourceId,
  resourceText,
} from "./native-api-resource.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const fieldId = z.union([
  resourceId,
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
]);
const fields = z.array(
  z.object({ id: fieldId, name: resourceText, type: resourceText }),
);
const named = z.object({ id: resourceId, name: resourceText });
const publications = z.object({
  data: z.array(named).max(20),
  limit: z.literal(20),
  page: z.literal(1),
  error: z.never().optional(),
  errors: z.never().optional(),
});
const workspaces = z.object({
  teams: z.array(named),
  error: z.never().optional(),
  errors: z.never().optional(),
});
export function projectBambooFields(body: BoundaryValue): BoundaryValue {
  return projectResourceCollection(
    fields.parse(body).map((field) => ({
      id: String(field.id),
      label: field.name,
    })),
    "field definitions",
    "returned",
  );
}
export function projectBeehiivPublications(body: BoundaryValue): BoundaryValue {
  return projectResourceCollection(
    publications.parse(body).data.map((item) => ({
      id: item.id,
      label: item.name,
    })),
    "publications",
    "first-page",
  );
}
export function projectClickUpWorkspaces(body: BoundaryValue): BoundaryValue {
  return projectResourceCollection(
    workspaces.parse(body).teams.map((item) => ({
      id: item.id,
      label: item.name,
    })),
    "workspaces",
    "returned",
  );
}
export const nativePrimaryCollections = [
  jsonResource(
    "List field definitions",
    {
      providerId: "bamboohr",
      operationId: "provider.fields.read",
      method: "GET",
      path: "/api/v1/meta/fields",
    },
    projectBambooFields,
  ),
  jsonResource(
    "List publications",
    {
      providerId: "beehiiv",
      operationId: "provider.publications.read",
      method: "GET",
      path: "/v2/publications",
      query: { limit: 20, page: 1 },
    },
    projectBeehiivPublications,
  ),
  jsonResource(
    "List workspaces",
    {
      providerId: "clickup",
      operationId: "provider.workspaces.read",
      method: "GET",
      path: "/api/v2/team",
    },
    projectClickUpWorkspaces,
  ),
];
