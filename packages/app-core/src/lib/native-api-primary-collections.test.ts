import { expect, it } from "vitest";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import {
  nativePrimaryCollections,
  projectBambooFields,
  projectBeehiivPublications,
  projectClickUpWorkspaces,
} from "./native-api-primary-collections.js";
import {
  invokeNativeApiResource,
  nativeApiResourceActions,
} from "./native-api-resources.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";

installNativeApiTests();
const field = { id: "4340.4", name: "Office", type: "text" };
const publication = { id: "pub_owned", name: "Journal" };
const workspace = { id: "7", name: "Engineering" };
const page = { data: [publication], limit: 20, page: 1 };
it("publishes exactly the three partner actions through the original registry", () => {
  for (const resource of nativePrimaryCollections) {
    expect(nativeApiResourceActions(resource.providerId, "api-key")).toEqual([
      { id: resource.id, label: resource.label },
    ]);
    expect(nativeApiResourceActions(resource.providerId, "oauth")).toEqual([]);
  }
  expect(nativeApiResourceActions("lithic", "api-key")).toEqual([
    { id: "provider.cards.read", label: "List cards" },
  ]);
  expect(nativeApiResourceActions("datadog", "api-key")).toEqual([
    { id: "provider.monitors.read", label: "List monitors" },
  ]);
  expect(nativeApiResourceActions("stripe", "api-key")).toEqual([
    { id: "provider.balance.read", label: "Read account balance" },
  ]);
});
it("normalizes official numeric/dotted field IDs and strips unused provider fields", () => {
  expect(
    projectBambooFields([
      { ...field, alias: "discard", deprecated: true },
      {
        id: 1,
        name: "Department",
        type: "list",
      },
    ]),
  ).toEqual({
    label: "Showing 2 of 2 returned field definitions",
    items: [
      { id: "4340.4", label: "Office" },
      { id: "1", label: "Department" },
    ],
  });
  expect(
    projectBeehiivPublications({
      ...page,
      data: [
        {
          ...publication,
          organization_name: "private-org",
          stats: { subscribers: 500 },
        },
      ],
    }),
  ).toEqual({
    label: "Showing 1 publications from first page",
    items: [{ id: "pub_owned", label: "Journal" }],
  });
  expect(
    projectClickUpWorkspaces({
      teams: [
        {
          ...workspace,
          members: [{ email: "private@example.test" }],
          avatar: "https://discard.test",
        },
      ],
    }),
  ).toEqual({
    label: "Showing 1 of 1 returned workspaces",
    items: [{ id: "7", label: "Engineering" }],
  });
});
it("preserves valid empty results without manufacturing account or inventory rows", () => {
  expect(projectBambooFields([])).toEqual({
    label: "Showing 0 of 0 returned field definitions",
    items: [],
  });
  expect(projectBeehiivPublications({ ...page, data: [] })).toEqual({
    label: "Showing 0 publications from first page",
    items: [],
  });
  expect(projectClickUpWorkspaces({ teams: [] })).toEqual({
    label: "Showing 0 of 0 returned workspaces",
    items: [],
  });
});
it("validates all returned rows before honestly truncating unpaginated APIs", () => {
  const rows = Array.from({ length: 37 }, (_, id) => ({
    id: String(id),
    name: `Row ${id}`,
    type: "text",
  }));
  expect(projectBambooFields(rows)).toMatchObject({
    label: "Showing 20 of 37 returned field definitions",
    items: rows.slice(0, 20).map((row) => ({ id: row.id, label: row.name })),
  });
  expect(projectClickUpWorkspaces({ teams: rows })).toMatchObject({
    label: "Showing 20 of 37 returned workspaces",
    items: rows.slice(0, 20).map((row) => ({ id: row.id, label: row.name })),
  });
  const duplicate = [...rows, rows[0]];
  expect(() => projectBambooFields(duplicate)).toThrow();
  expect(() => projectClickUpWorkspaces({ teams: duplicate })).toThrow();
  expect(() =>
    projectBambooFields([
      ...rows,
      { ...field, id: "last", name: "bad\nlabel" },
    ]),
  ).toThrow();
});
it.each(
  [
    {},
    null,
    [null],
    [{ name: "No id", type: "text" }],
    [{ id: "4340.4", name: "Missing type" }],
    [{ ...field, id: 1.5 }],
    [{ ...field, id: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...field, id: "" }],
    [{ ...field, id: "x".repeat(257) }],
    [{ ...field, name: "" }],
    [{ ...field, name: "bad\u007flabel" }],
    [{ ...field, name: "x".repeat(4097) }],
    [{ ...field }, { ...field }],
    [
      { ...field, id: 1 },
      { ...field, id: "1" },
    ],
  ].map((body) => ({ body })),
)("refuses malformed field inventories %#", ({ body }) => {
  expect(() => projectBambooFields(body)).toThrow();
});
it.each(
  [
    {},
    { ...page, data: null },
    { ...page, limit: 100 },
    { ...page, page: 2 },
    { ...page, data: [{ ...publication, id: 1 }] },
    { ...page, data: [publication, publication] },
    {
      ...page,
      data: Array.from({ length: 21 }, (_, id) => ({
        id: String(id),
        name: "Too many",
      })),
    },
    { ...page, error: "refused" },
    { ...page, errors: ["refused"] },
  ].map((body) => ({ body })),
)("refuses malformed or nonfirst Beehiiv pages %#", ({ body }) => {
  expect(() => projectBeehiivPublications(body)).toThrow();
});
it.each(
  [
    {},
    { teams: null },
    { teams: [{ ...workspace, id: 1 }] },
    { teams: [workspace, workspace] },
    { teams: [{ ...workspace, name: "bad\nlabel" }] },
    { teams: [workspace], error: "refused" },
    { teams: [workspace], errors: ["refused"] },
  ].map((body) => ({ body })),
)("refuses malformed workspace collections %#", ({ body }) => {
  expect(() => projectClickUpWorkspaces(body)).toThrow();
});
it("refuses arbitrary action fields and cross-provider operations before transport", async () => {
  const { transport, fetch } = nativeAnswers();
  for (const resource of nativePrimaryCollections) {
    for (const key of ["url", "body", "page", "api_key"])
      await expect(
        resource.read("not-saved", { [key]: "override" }, transport),
      ).rejects.toThrow("does not accept");
    expect(
      invokeNativeApiResource(
        "stripe",
        "not-saved",
        resource.id,
        {},
        transport,
      ),
    ).toBeNull();
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects encoded or raw credential reflections through the unchanged request executor", async () => {
  const key = "primary:private~key";
  for (const name of [key, encodeURIComponent(key)]) {
    const { transport } = nativeAnswers(
      { body: { user: { username: "Owned" } } },
      { body: { teams: [{ ...workspace, name }] } },
    );
    const view = await configureNativeApiConnector(
      {
        providerId: "clickup",
        displayName: "Workspaces",
        parameters: {},
        credentials: { api_key: key },
      },
      transport,
    );
    await expect(
      invokeNativeApiResource(
        "clickup",
        view.connectionId,
        "provider.workspaces.read",
        {},
        transport,
      ),
    ).rejects.toMatchObject({ code: "response" });
  }
});
