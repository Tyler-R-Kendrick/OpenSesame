/** Useful inventories compose the shared request, custody and result boundaries. */
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
const pipelines = z.array(named).max(20);
const projectPipelines = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        project_slug: resourceId,
        state: z.enum([
          "created",
          "errored",
          "setup-pending",
          "setup",
          "pending",
        ]),
      }),
    )
    .max(1000),
  next_page_token: z.string().max(8192).nullable(),
  message: z.never().optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
});
const droplets = z.object({
  droplets: z
    .array(
      named.extend({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(20),
  message: z.never().optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
});
const projects = z.object({
  projects: z.array(named).max(20),
  page: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  success: z.literal(true).optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
  messages: z.never().optional(),
});
export function projectBuildkitePipelines(body: BoundaryValue) {
  return projectResourceCollection(
    pipelines.parse(body).map(({ id, name }) => ({ id, label: name })),
    "pipelines",
    "first-page",
  );
}
export function projectCircleCiPipelines(body: BoundaryValue, project: string) {
  const response = projectPipelines.parse(body);
  if (response.items.some((item) => item.project_slug !== project))
    throw new NativeApiError("response");
  return projectResourceCollection(
    response.items.map((item) => ({
      id: item.id.toLowerCase(),
      label: `Pipeline ${item.number} — ${item.state}`,
    })),
    "pipelines from first page",
    "returned",
  );
}
export function projectDigitalOceanDroplets(body: BoundaryValue) {
  return projectResourceCollection(
    droplets.parse(body).droplets.map(({ id, name }) => ({
      id: String(id),
      label: name,
    })),
    "non-GPU droplets",
    "first-page",
  );
}
export function projectDopplerProjects(body: BoundaryValue) {
  return projectResourceCollection(
    projects.parse(body).projects.map(({ id, name }) => ({ id, label: name })),
    "projects",
    "first-page",
  );
}
function segment(value: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.length > 256 ||
    /[\s/%\\?#]/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Configure a canonical organization or project slug.");
  return encodeURIComponent(value);
}
function inventoryPath(provider: string, target: string) {
  if (provider === "buildkite")
    return `/v2/organizations/${segment(target)}/pipelines`;
  const parts = target.split("/");
  if (parts.length !== 3)
    throw new Error("Configure the CircleCI project slug as vcs/org/project.");
  return `/api/v2/project/${parts.map(segment).join("/")}/pipeline`;
}
function scopedPipelines(providerId: "buildkite" | "circleci"): Resource {
  const field =
    providerId === "buildkite" ? "organization_slug" : "project_slug";
  const label =
    providerId === "buildkite" ? "List pipelines" : "List project pipelines";
  return {
    providerId,
    id: "provider.pipelines.read",
    label,
    async read(id, input, transport) {
      transport.assertCurrent();
      if (Object.keys(input).length)
        throw new Error(
          "Pipeline inventory does not accept request overrides.",
        );
      const saved = readNativeConnector(id);
      if (
        saved?.providerId !== providerId ||
        saved.configuration.method !== "api-key"
      )
        throw new Error("Use this provider's verified saved API connection.");
      const revision = saved.revision;
      const fingerprint = saved.fingerprint;
      const target = saved.configuration.parameters[field] ?? "";
      const path = inventoryPath(providerId, target);
      const current = () => {
        transport.assertCurrent();
        const latest = readNativeConnector(id);
        if (
          !latest ||
          latest.revision !== revision ||
          latest.fingerprint !== fingerprint
        )
          throw new Error(
            "The saved inventory target changed. Reopen its configuration.",
          );
      };
      const result = await jsonResource(
        label,
        {
          providerId,
          operationId: "provider.pipelines.read",
          method: "GET",
          path,
          query:
            providerId === "buildkite" ? { page: 1, per_page: 20 } : undefined,
          onDispatch: current,
        },
        providerId === "buildkite"
          ? projectBuildkitePipelines
          : (body) => projectCircleCiPipelines(body, target),
      ).read(id, input, transport);
      current();
      return result;
    },
  };
}
export const nativeCiCloudResources: readonly Resource[] = [
  scopedPipelines("buildkite"),
  scopedPipelines("circleci"),
  jsonResource(
    "List droplets",
    {
      providerId: "digitalocean",
      operationId: "provider.droplets.read",
      method: "GET",
      path: "/v2/droplets",
      query: { page: 1, per_page: 20 },
    },
    projectDigitalOceanDroplets,
  ),
  jsonResource(
    "List accessible projects",
    {
      providerId: "doppler",
      operationId: "provider.projects.read",
      method: "GET",
      path: "/v3/projects",
      query: { page: 1, per_page: 20 },
    },
    projectDopplerProjects,
  ),
];
