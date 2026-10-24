/** Provider inventories share the existing sealed request and bounded result surface. */
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
import { readNativeConnector } from "./native-connector-store.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const named = z.object({ id: resourceId, name: resourceText });
const failures = {
  error: z.never().optional(),
  errors: z.never().optional(),
  message: z.never().optional(),
  success: z.literal(true).optional(),
  ok: z.literal(true).optional(),
  status: z.never().optional(),
};
const projects = z.object({
  projects: z.array(named.extend({ org_id: resourceId.optional() })).max(20),
  pagination: z
    .object({ cursor: z.string().max(8192).nullable().optional() })
    .optional(),
  // An incomplete timeout response must not masquerade as verified inventory.
  unavailable: z.array(z.never()).optional(),
  ...failures,
});
const indexName = z
  .string()
  .min(1)
  .max(45)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const indexes = z.object({
  indexes: z.array(z.object({ name: indexName })).max(1000),
  ...failures,
});
const workflows = z.object({
  data: z.array(named).max(20),
  nextCursor: z.string().max(8192).nullable().optional(),
  ...failures,
});
const domains = z.object({
  items: z.array(named).max(20),
  total_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ...failures,
});
export function projectNeonProjects(body: BoundaryValue, organization: string) {
  const response = projects.parse(body);
  if (
    response.projects.some(
      (project) =>
        project.org_id !== undefined && project.org_id !== organization,
    )
  )
    throw new NativeApiError("response");
  return projectResourceCollection(
    response.projects.map(({ id, name }) => ({ id, label: name })),
    "projects",
    "first-page",
  );
}
export function projectPineconeIndexes(body: BoundaryValue) {
  return projectResourceCollection(
    indexes.parse(body).indexes.map(({ name }) => ({ id: name, label: name })),
    "indexes",
    "returned",
  );
}
export function projectN8nWorkflows(body: BoundaryValue) {
  return projectResourceCollection(
    workflows.parse(body).data.map(({ id, name }) => ({ id, label: name })),
    "workflows",
    "first-page",
  );
}
export function projectMailgunDomains(body: BoundaryValue) {
  const response = domains.parse(body);
  if (response.total_count < response.items.length)
    throw new NativeApiError("response");
  return projectResourceCollection(
    response.items.map(({ id, name }) => ({ id, label: name })),
    "domains",
    "first-page",
  );
}
const neonProjects: Resource = {
  providerId: "neon",
  id: "provider.projects.read",
  label: "List projects",
  async read(id, input, transport) {
    transport.assertCurrent();
    if (Object.keys(input).length)
      throw new Error("Project inventory does not accept request overrides.");
    const saved = readNativeConnector(id);
    if (
      saved?.providerId !== "neon" ||
      saved.configuration.method !== "api-key"
    )
      throw new Error("Use the verified saved Neon API connection.");
    const organization = resourceId.parse(
      saved.configuration.parameters.org_id,
    );
    const current = () => {
      transport.assertCurrent();
      const latest = readNativeConnector(id);
      if (
        latest?.revision !== saved.revision ||
        latest?.fingerprint !== saved.fingerprint
      )
        throw new Error(
          "The saved Neon organization changed. Reopen its configuration.",
        );
    };
    const result = await jsonResource(
      "List projects",
      {
        providerId: "neon",
        operationId: "provider.projects.read",
        method: "GET",
        path: "/api/v2/projects",
        query: { limit: 20, org_id: organization },
        onDispatch: current,
      },
      (body) => projectNeonProjects(body, organization),
    ).read(id, input, transport);
    current();
    return result;
  },
};
export const nativeDataWorkspaceResources: readonly Resource[] = [
  neonProjects,
  jsonResource(
    "List indexes",
    {
      providerId: "pinecone",
      operationId: "provider.indexes.read",
      method: "GET",
      path: "/indexes",
      headers: { "X-Pinecone-API-Version": "2025-04" },
    },
    projectPineconeIndexes,
  ),
  jsonResource(
    "List workflows",
    {
      providerId: "n8n",
      operationId: "provider.workflows.read",
      method: "GET",
      path: "/api/v1/workflows",
      query: { limit: 20, excludePinnedData: true },
    },
    projectN8nWorkflows,
  ),
  jsonResource(
    "List domains",
    {
      providerId: "mailgun",
      operationId: "provider.domains.read",
      method: "GET",
      path: "/v4/domains",
      query: { limit: 20, skip: 0 },
    },
    projectMailgunDomains,
  ),
];
