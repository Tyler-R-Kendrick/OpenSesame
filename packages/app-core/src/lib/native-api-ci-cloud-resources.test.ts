import { expect, it } from "vitest";
import {
  nativeCiCloudResources,
  projectBuildkitePipelines,
  projectCircleCiPipelines,
  projectDigitalOceanDroplets,
  projectDopplerProjects,
} from "./native-api-ci-cloud-resources.js";
import { nativeApiResourceActions } from "./native-api-resources.js";

const pipeline = { id: "pipeline_owned", name: "Release" };
const project = "gh/owned/project";
const run = {
  id: "5034460f-c7c4-4c43-9457-de07e2029e7b",
  number: 25,
  project_slug: project,
  state: "created",
};
const droplet = { id: 3164444, name: "web-01" };
const application = { id: "ed0c2a68b6", name: "Compression" };
it("publishes four bounded inventories through the original API-key action registry", () => {
  for (const resource of nativeCiCloudResources) {
    expect(nativeApiResourceActions(resource.providerId, "api-key")).toEqual([
      { id: resource.id, label: resource.label },
    ]);
    expect(nativeApiResourceActions(resource.providerId, "oauth")).toEqual([]);
  }
  expect(nativeApiResourceActions("gitlab", "api-key")).toEqual([
    { id: "provider.projects.read", label: "List membership projects" },
  ]);
});
it("projects Buildkite IDs/names without repository, environment, steps or webhook credentials", () => {
  expect(
    projectBuildkitePipelines([
      {
        ...pipeline,
        repository: "git@private.example:project",
        env: { KEY: "private-key" },
        steps: [{ command: "private-command" }],
        provider: { webhook_url: "https://private.example/hook" },
      },
    ]),
  ).toEqual({
    label: "Showing 1 pipelines from first page",
    items: [{ id: pipeline.id, label: pipeline.name }],
  });
});
it("retains real errored CircleCI pipelines while stripping nested error text, trigger parameters and VCS metadata", () => {
  expect(
    projectCircleCiPipelines(
      {
        items: [
          {
            ...run,
            state: "errored",
            errors: [{ type: "config", message: "private-error" }],
            trigger_parameters: { SECRET: "private-secret" },
            vcs: { branch: "private-branch", commit: { body: "private-body" } },
          },
        ],
        next_page_token: null,
      },
      project,
    ),
  ).toEqual({
    label: "Showing 1 of 1 returned pipelines from first page",
    items: [{ id: run.id, label: "Pipeline 25 — errored" }],
  });
});
it("validates the whole CircleCI page but displays only twenty without following an opaque cursor", () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    ...run,
    id: `5034460f-c7c4-4c43-9457-${String(index).padStart(12, "0")}`,
    number: index + 1,
  }));
  const body = { items, next_page_token: "opaque-private-cursor" };
  const result = projectCircleCiPipelines(body, project);
  expect(result.label).toBe(
    "Showing 20 of 25 returned pipelines from first page",
  );
  expect(result.items).toHaveLength(20);
  expect(JSON.stringify(result)).not.toContain("opaque-private-cursor");
  expect(() =>
    projectCircleCiPipelines({ ...body, items: [...items, items[0]] }, project),
  ).toThrow();
  expect(() =>
    projectCircleCiPipelines(
      {
        ...body,
        items: [...items, { ...run, project_slug: "gh/other/project" }],
      },
      project,
    ),
  ).toThrow();
});
it("projects DigitalOcean's exact safe integer IDs and names without network, SSH or backup metadata", () => {
  expect(
    projectDigitalOceanDroplets({
      droplets: [
        {
          ...droplet,
          networks: { v4: [{ ip_address: "10.0.0.1" }] },
          ssh_keys: ["private-key"],
          vpc_uuid: "private-vpc",
          backup_ids: [9],
        },
      ],
      links: { pages: { next: "https://untrusted.example/next" } },
      meta: { total: 50 },
    }),
  ).toEqual({
    label: "Showing 1 non-GPU droplets from first page",
    items: [{ id: String(droplet.id), label: droplet.name }],
  });
});
it("accepts Doppler's documented flagless response and exposes project identity without descriptions or secrets", () => {
  expect(
    projectDopplerProjects({
      page: 1,
      projects: [
        { ...application, slug: "compression", description: "private" },
      ],
    }),
  ).toEqual({
    label: "Showing 1 projects from first page",
    items: [{ id: application.id, label: application.name }],
  });
  expect(projectDopplerProjects({ projects: [] }).items).toEqual([]);
});
it.each(
  [
    null,
    {},
    { pipelines: [] },
    [{ ...pipeline, id: "" }],
    [{ ...pipeline, name: "bad\nlabel" }],
    [pipeline, pipeline],
    Array.from({ length: 21 }, (_, index) => ({
      ...pipeline,
      id: String(index),
    })),
  ].map((body) => ({ body })),
)("rejects malformed or oversized Buildkite pages %#", ({ body }) => {
  expect(() => projectBuildkitePipelines(body)).toThrow();
});
it.each(
  [
    {},
    { items: [], next_page_token: null, message: "refused" },
    { items: [], next_page_token: 4 },
    { items: [{ ...run, id: "not-a-uuid" }], next_page_token: null },
    { items: [{ ...run, number: 1.5 }], next_page_token: "" },
    {
      items: [{ ...run, number: Number.MAX_SAFE_INTEGER + 1 }],
      next_page_token: "",
    },
    { items: [{ ...run, state: "success" }], next_page_token: null },
    {
      items: [{ ...run, project_slug: "gh/other/project" }],
      next_page_token: null,
    },
    {
      items: [run, { ...run, id: run.id.toUpperCase() }],
      next_page_token: null,
    },
  ].map((body) => ({ body })),
)("rejects invalid or cross-project CircleCI responses %#", ({ body }) => {
  expect(() => projectCircleCiPipelines(body, project)).toThrow();
});
it.each(
  [
    {},
    { droplets: [], message: "refused" },
    { droplets: [{ ...droplet, id: "3164444" }] },
    { droplets: [{ ...droplet, id: -1 }] },
    { droplets: [{ ...droplet, id: Number.MAX_SAFE_INTEGER + 1 }] },
    { droplets: [droplet, droplet] },
    {
      droplets: Array.from({ length: 21 }, (_, index) => ({
        ...droplet,
        id: index + 1,
      })),
    },
  ].map((body) => ({ body })),
)("rejects malformed or inexact DigitalOcean inventory %#", ({ body }) => {
  expect(() => projectDigitalOceanDroplets(body)).toThrow();
});
it.each(
  [
    {},
    { projects: [], success: false },
    { projects: [], messages: ["permission denied"] },
    { projects: [application], page: -1 },
    { projects: [{ ...application, id: "x".repeat(257) }] },
    { projects: [application, application] },
    {
      projects: Array.from({ length: 21 }, (_, index) => ({
        ...application,
        id: String(index),
      })),
    },
  ].map((body) => ({ body })),
)("rejects malformed or denied Doppler inventory %#", ({ body }) => {
  expect(() => projectDopplerProjects(body)).toThrow();
});
