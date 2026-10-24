/** Provider-owned named inventories compose the existing closed request and result surface. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import {
  type Resource,
  jsonResource,
  projectResourceCollection,
  resourceId,
  resourceText,
} from "./native-api-resource.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const failures = {
  error: z.never().optional(),
  errors: z.never().optional(),
  code: z.never().optional(),
  message: z.never().optional(),
  status: z.never().optional(),
  success: z.literal(true).optional(),
  ok: z.literal(true).optional(),
};
const brevoLists = z.object({
  lists: z.array(z.object({ id: count, name: resourceText })).max(20),
  count: count.optional(),
  ...failures,
});
const sendgridLists = z.object({
  result: z
    .array(
      z.object({
        id: resourceId.refine((value) => value.length === 36),
        name: resourceText,
      }),
    )
    .max(20),
  _metadata: z.object({ count: count.optional() }).optional(),
  ...failures,
});
const launchdarklyProjects = z.object({
  items: z.array(z.object({ key: resourceId, name: resourceText })).max(20),
  totalCount: count.optional(),
  ...failures,
});
export function projectBrevoLists(body: BoundaryValue) {
  const response = brevoLists.parse(body);
  if (response.count !== undefined && response.count < response.lists.length)
    throw new NativeApiError("response");
  return projectResourceCollection(
    response.lists.map(({ id, name }) => ({ id: String(id), label: name })),
    "contact lists",
    "first-page",
  );
}
export function projectSendgridLists(body: BoundaryValue) {
  const response = sendgridLists.parse(body);
  if (
    response._metadata?.count !== undefined &&
    response._metadata.count < response.result.length
  )
    throw new NativeApiError("response");
  return projectResourceCollection(
    response.result.map(({ id, name }) => ({ id, label: name })),
    "marketing lists",
    "first-page",
  );
}
export function projectLaunchDarklyProjects(body: BoundaryValue) {
  const response = launchdarklyProjects.parse(body);
  if (
    response.totalCount !== undefined &&
    response.totalCount < response.items.length
  )
    throw new NativeApiError("response");
  return projectResourceCollection(
    response.items.map(({ key, name }) => ({ id: key, label: name })),
    "projects",
    "first-page",
  );
}
export const nativeServiceInventories: readonly Resource[] = [
  jsonResource(
    "List contact lists",
    {
      providerId: "brevo",
      operationId: "provider.contact-lists.read",
      method: "GET",
      path: "/v3/contacts/lists",
      query: { limit: 20, offset: 0 },
    },
    projectBrevoLists,
  ),
  jsonResource(
    "List marketing lists",
    {
      providerId: "sendgrid",
      operationId: "provider.marketing-lists.read",
      method: "GET",
      path: "/v3/marketing/lists",
      query: { page_size: 20 },
    },
    projectSendgridLists,
  ),
  jsonResource(
    "List projects",
    {
      providerId: "launchdarkly",
      operationId: "provider.projects.read",
      method: "GET",
      path: "/api/v2/projects",
      query: { limit: 20, offset: 0 },
    },
    projectLaunchDarklyProjects,
  ),
];
