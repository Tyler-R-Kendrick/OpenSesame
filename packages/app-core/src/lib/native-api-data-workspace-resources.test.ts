import { expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import {
  nativeDataWorkspaceResources,
  projectMailgunDomains,
  projectN8nWorkflows,
  projectNeonProjects,
  projectPineconeIndexes,
} from "./native-api-data-workspace-resources.js";
import { nativeApiResourceActions } from "./native-api-resources.js";

const named = { id: "owned-id", name: "Owned resource" };
const organization = "org-spring-garden-12345";
const cases = [
  {
    id: "neon",
    parse: (body: Parameters<typeof projectNeonProjects>[0]) =>
      projectNeonProjects(body, organization),
    body: { projects: [{ ...named, org_id: organization }] },
    empty: { projects: [] },
  },
  {
    id: "pinecone",
    parse: projectPineconeIndexes,
    body: { indexes: [{ name: "owned-index" }] },
    empty: { indexes: [] },
  },
  {
    id: "n8n",
    parse: projectN8nWorkflows,
    body: { data: [named], nextCursor: null },
    empty: { data: [] },
  },
  {
    id: "mailgun",
    parse: projectMailgunDomains,
    body: { items: [named], total_count: 1 },
    empty: { items: [], total_count: 0 },
  },
];
it("adds only four actual API-key inventories and preserves the previously published four", () => {
  for (const resource of nativeDataWorkspaceResources) {
    expect(nativeApiResourceActions(resource.providerId, "api-key")).toEqual([
      { id: resource.id, label: resource.label },
    ]);
    expect(nativeApiResourceActions(resource.providerId, "oauth")).toEqual([]);
  }
  for (const id of ["buildkite", "circleci", "digitalocean", "doppler"])
    expect(nativeApiResourceActions(id, "api-key")).toHaveLength(1);
});
it("binds Neon organization selection and current bounded Mailgun v4 verification through common preset fields", () => {
  const neon = connectPlan("neon")?.methods.find(
    (method) => method.kind === "api-key",
  );
  const mailgun = connectPlan("mailgun")?.methods.find(
    (method) => method.kind === "api-key",
  );
  if (neon?.kind !== "api-key" || mailgun?.kind !== "api-key")
    throw new Error("Missing real presets");
  expect(neon.preset?.templateParams).toContainEqual(
    expect.objectContaining({ name: "org_id", secret: false, required: true }),
  );
  expect(neon.preset?.verify?.url).toBe(
    "https://console.neon.tech/api/v2/projects?limit=20&org_id={org_id}",
  );
  expect(mailgun.preset?.verify?.url).toBe(
    "https://{api_host}/v4/domains?limit=20&skip=0",
  );
  expect(
    mailgun.preset?.templateParams[0]?.choices?.map(({ value }) => value),
  ).toEqual(["api.mailgun.net", "api.eu.mailgun.net"]);
});
it.each(cases)(
  "$id accepts genuine empty inventories without manufacturing an item",
  ({ parse, empty }) => {
    expect(parse(empty)).toMatchObject({ items: [] });
  },
);
it.each(cases)(
  "$id rejects top-level failed envelopes even alongside valid collection data",
  ({ parse, body }) => {
    for (const fault of [
      { error: { code: "Forbidden" } },
      { errors: ["denied"] },
      { success: false },
      { ok: false },
      { status: "error" },
      { message: "denied" },
    ])
      expect(() => parse({ ...body, ...fault })).toThrow();
  },
);
it.each(cases)(
  "$id refuses missing, duplicate or unprintable resource identities",
  ({ id, parse, body }) => {
    expect(() => parse({ malformed: true })).toThrow();
    if (id === "pinecone") {
      for (const indexes of [
        [{ name: "owned-index" }, { name: "owned-index" }],
        [{ name: "Bad_Name" }],
        [{ name: "trailing-" }],
        [{ name: "x".repeat(46) }],
      ])
        expect(() => parse({ indexes })).toThrow();
      return;
    }
    const key = id === "neon" ? "projects" : id === "n8n" ? "data" : "items";
    expect(() => parse({ ...body, [key]: [named, named] })).toThrow();
    expect(() =>
      parse({ ...body, [key]: [{ ...named, id: "bad\nid" }] }),
    ).toThrow();
    expect(() => parse({ ...body, [key]: [{ ...named, name: "" }] })).toThrow();
  },
);
it("validates every unpaginated Pinecone index before displaying only twenty, without exposing hosts or model settings", () => {
  const indexes = Array.from({ length: 25 }, (_, index) => ({
    name: `owned-${index}`,
    host: "private.example",
    embed: { model: "private-model" },
  }));
  const result = projectPineconeIndexes({ indexes });
  expect(result.label).toBe("Showing 20 of 25 returned indexes");
  expect(result.items).toHaveLength(20);
  expect(JSON.stringify(result)).not.toMatch(/private.example|private-model/);
  expect(() =>
    projectPineconeIndexes({ indexes: [...indexes, { name: "INVALID" }] }),
  ).toThrow();
  expect(() =>
    projectPineconeIndexes({ indexes: [...indexes, indexes[0]] }),
  ).toThrow();
});
it("refuses a partial Neon timeout response or another organization's returned project", () => {
  expect(() =>
    projectNeonProjects(
      { projects: [named], unavailable: ["missing-project"] },
      organization,
    ),
  ).toThrow();
  expect(() =>
    projectNeonProjects(
      { projects: [{ ...named, org_id: "org-other" }] },
      organization,
    ),
  ).toThrow();
  expect(
    projectNeonProjects(
      {
        projects: [{ ...named, settings: { private: "secret" } }],
        pagination: { cursor: "opaque" },
      },
      organization,
    ),
  ).toEqual({
    label: "Showing 1 projects from first page",
    items: [{ id: named.id, label: named.name }],
  });
});
it("discards n8n workflow internals and Mailgun SMTP credentials and rejects inconsistent total counts", () => {
  expect(
    projectN8nWorkflows({
      data: [
        {
          ...named,
          nodes: [{ credentials: "private-node" }],
          pinData: { secret: "private-pinned" },
        },
      ],
      nextCursor: "https://untrusted.example",
    }),
  ).toEqual({
    label: "Showing 1 workflows from first page",
    items: [{ id: named.id, label: named.name }],
  });
  expect(
    projectMailgunDomains({
      items: [
        {
          ...named,
          smtp_password: "private-smtp",
          archive_to: "private-archive",
        },
      ],
      total_count: 21,
    }),
  ).toEqual({
    label: "Showing 1 domains from first page",
    items: [{ id: named.id, label: named.name }],
  });
  expect(() =>
    projectMailgunDomains({ items: [named], total_count: 0 }),
  ).toThrow();
});
it.each(["neon", "n8n", "mailgun"])(
  "%s refuses an oversized first page rather than truncating a broken contract",
  (id) => {
    const item = cases.find((item) => item.id === id);
    if (!item) throw new Error("Missing case");
    const key = id === "neon" ? "projects" : id === "n8n" ? "data" : "items";
    expect(() =>
      item.parse({
        [key]: Array.from({ length: 21 }, (_, index) => ({
          id: `owned-${index}`,
          name: "Owned",
        })),
        total_count: 21,
      }),
    ).toThrow();
  },
);
