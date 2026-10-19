import { expect, it } from "vitest";
import {
  nativeCatalogResources,
  projectDovetailProjects,
  projectGitLabProjects,
  projectNetlifySites,
  projectNewsSources,
  projectRenderWorkspaces,
} from "./native-api-catalog-resources.js";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import {
  invokeNativeApiResource,
  nativeApiResourceActions,
} from "./native-api-resources.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";

installNativeApiTests();
const site = { id: "site_owned", name: "Documentation" };
const workspace = { id: "tea_owned", name: "Team", type: "team" };
const source = { id: "owned-news", name: "Newsroom" };
const project = { id: 17, name: "Client" };
it("exposes actual product reads through the original API-key registry", () => {
  for (const resource of nativeCatalogResources) {
    expect(nativeApiResourceActions(resource.providerId, "api-key")).toEqual([
      { id: resource.id, label: resource.label },
    ]);
    expect(nativeApiResourceActions(resource.providerId, "oauth")).toEqual([]);
  }
  expect(nativeApiResourceActions("bamboohr", "api-key")).toEqual([
    { id: "provider.fields.read", label: "List field definitions" },
  ]);
  expect(nativeApiResourceActions("privacy", "api-key")).toEqual([
    { id: "provider.cards.read", label: "List cards" },
  ]);
});
it("projects only site IDs and names, dropping passwords, deploy hooks and build secrets", () => {
  expect(
    projectNetlifySites([
      {
        ...site,
        password: "private-password",
        build_settings: { env: { SECRET: "private-env" } },
        default_hooks_data: { access_token: "private-token" },
        admin_url: "https://discard.test",
      },
    ]),
  ).toEqual({
    label: "Showing 1 sites from first page",
    items: [{ id: site.id, label: site.name }],
  });
});
it("projects workspace IDs and names without owner email, IP allowlists, cursors or security settings", () => {
  expect(
    projectRenderWorkspaces([
      {
        owner: {
          ...workspace,
          email: "private@example.test",
          ipAllowList: [{ cidrBlock: "10.0.0.0/8", description: "private" }],
          twoFactorAuthEnabled: true,
        },
        cursor: "private-cursor",
      },
    ]),
  ).toEqual({
    label: "Showing 1 workspaces from first page",
    items: [{ id: workspace.id, label: workspace.name }],
  });
});
it("projects published source IDs and names without descriptions or arbitrary publisher URLs", () => {
  expect(
    projectNewsSources({
      status: "ok",
      sources: [
        {
          ...source,
          description: "private-description",
          url: "javascript:discard",
          country: "gb",
          language: "en",
        },
      ],
    }),
  ).toEqual({
    label: "Showing 1 of 1 returned news sources",
    items: [{ id: source.id, label: source.name }],
  });
});
it("projects exact safe project IDs and names without repository, CI or owner metadata", () => {
  expect(
    projectGitLabProjects([
      {
        ...project,
        id: Number.MAX_SAFE_INTEGER,
        http_url_to_repo: "https://discard.test",
        web_url: "https://discard.test",
        owner: { email: "private@example.test" },
        ci_config_path: "private-ci",
      },
    ]),
  ).toEqual({
    label: "Showing 1 membership projects from first page",
    items: [{ id: "9007199254740991", label: project.name }],
  });
});
it("keeps genuine empty collections empty across all four documented envelopes", () => {
  expect(projectNetlifySites([])).toEqual({
    label: "Showing 0 sites from first page",
    items: [],
  });
  expect(projectRenderWorkspaces([])).toEqual({
    label: "Showing 0 workspaces from first page",
    items: [],
  });
  expect(projectNewsSources({ status: "ok", sources: [] })).toEqual({
    label: "Showing 0 of 0 returned news sources",
    items: [],
  });
  expect(projectGitLabProjects([])).toEqual({
    label: "Showing 0 membership projects from first page",
    items: [],
  });
});
it("accepts exactly twenty unique rows for each server-paginated route", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: `item_${index}`,
    name: `Item ${index}`,
  }));
  expect(projectNetlifySites(rows)).toMatchObject({
    items: rows.map((row) => ({ id: row.id, label: row.name })),
  });
  expect(
    projectRenderWorkspaces(
      rows.map((owner) => ({ owner: { ...owner, type: "team" } })),
    ),
  ).toMatchObject({
    items: rows.map((row) => ({ id: row.id, label: row.name })),
  });
  expect(
    projectGitLabProjects(
      rows.map((row, index) => ({ ...row, id: index + 1 })),
    ),
  ).toMatchObject({
    items: rows.map((row, index) => ({
      id: String(index + 1),
      label: row.name,
    })),
  });
});
it("validates all NewsAPI rows and gives an honest display count without fabricating pagination", () => {
  const sources = Array.from({ length: 37 }, (_, index) => ({
    id: `source_${index}`,
    name: `Source ${index}`,
  }));
  expect(projectNewsSources({ status: "ok", sources })).toEqual({
    label: "Showing 20 of 37 returned news sources",
    items: sources
      .slice(0, 20)
      .map((item) => ({ id: item.id, label: item.name })),
  });
  expect(() =>
    projectNewsSources({ status: "ok", sources: [...sources, sources[0]] }),
  ).toThrow();
  expect(() =>
    projectNewsSources({
      status: "ok",
      sources: [...sources, { id: "last", name: "bad\nlabel" }],
    }),
  ).toThrow();
});
it.each(
  [
    {},
    null,
    { sites: [] },
    [null],
    [{ ...site, id: 1 }],
    [{ ...site, id: "" }],
    [{ ...site, name: "" }],
    [{ ...site, name: "bad\u007flabel" }],
    [{ ...site, name: "x".repeat(4097) }],
    [site, site],
    Array.from({ length: 21 }, (_, id) => ({
      id: String(id),
      name: "Too many",
    })),
  ].map((body) => ({ body })),
)("rejects malformed or oversized site inventory %#", ({ body }) => {
  expect(() => projectNetlifySites(body)).toThrow();
});
it.each(
  [
    {},
    { owner: workspace },
    [{}],
    [{ owner: { id: workspace.id } }],
    [{ owner: { ...workspace, type: "organization" } }],
    [{ owner: { ...workspace, id: 17 } }],
    [{ owner: { ...workspace, name: "bad\nlabel" } }],
    [{ owner: workspace }, { owner: workspace }],
    Array.from({ length: 21 }, (_, id) => ({
      owner: { id: String(id), name: "Too many", type: "team" },
    })),
  ].map((body) => ({ body })),
)("rejects malformed workspace cursor envelopes %#", ({ body }) => {
  expect(() => projectRenderWorkspaces(body)).toThrow();
});
it.each(
  [
    {},
    { status: "error", code: "apiKeyInvalid", sources: [source] },
    { status: "ok", sources: null },
    { status: "ok", sources: [{ ...source, id: 1 }] },
    { status: "ok", sources: [{ ...source, id: "x".repeat(257) }] },
    { status: "ok", sources: [{ ...source, name: "" }] },
    { status: "ok", sources: [source, source] },
    { status: "ok", sources: [source], code: "refused" },
    { status: "ok", sources: [source], message: "refused" },
  ].map((body) => ({ body })),
)("rejects provider errors and malformed published sources %#", ({ body }) => {
  expect(() => projectNewsSources(body)).toThrow();
});
it.each(
  [
    {},
    null,
    { projects: [] },
    [{ ...project, id: "17" }],
    [{ ...project, id: 0 }],
    [{ ...project, id: -1 }],
    [{ ...project, id: 1.5 }],
    [{ ...project, id: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...project, name: "bad\nlabel" }],
    [project, project],
    Array.from({ length: 21 }, (_, id) => ({ ...project, id: id + 1 })),
  ].map((body) => ({ body })),
)("rejects invalid, inexact or duplicate project IDs %#", ({ body }) => {
  expect(() => projectGitLabProjects(body)).toThrow();
});
it("refuses caller-selected targets, query/body/auth overrides and cross-provider operations before dispatch", async () => {
  const { transport, fetch } = nativeAnswers();
  for (const resource of nativeCatalogResources) {
    for (const key of [
      "url",
      "body",
      "page",
      "api_key",
      "membership",
      "teamId",
    ])
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
it("rejects raw and encoded saved header-key reflections through the unchanged executor", async () => {
  const key = "owned/header:key~private";
  for (const name of [key, encodeURIComponent(key)]) {
    const { transport } = nativeAnswers(
      { body: { status: "ok", sources: [] } },
      { body: { status: "ok", sources: [{ ...source, name }] } },
    );
    const view = await configureNativeApiConnector(
      {
        providerId: "newsapi",
        displayName: "Sources",
        parameters: {},
        credentials: { api_key: key },
      },
      transport,
    );
    await expect(
      invokeNativeApiResource(
        "newsapi",
        view.connectionId,
        "provider.sources.read",
        {},
        transport,
      ),
    ).rejects.toMatchObject({ code: "response" });
  }
});

const dovetailProject = {
  id: "research-1",
  title: "Research",
  type: "project",
  deleted: false,
};
const dovetailPage = { total_count: 1, has_more: false, next_cursor: null };
it("projects active Dovetail titles without author, content, URL, deleted rows or cursor", () => {
  expect(
    projectDovetailProjects({
      data: [
        {
          ...dovetailProject,
          author: { name: "private-person" },
          url: "javascript:private",
        },
        {
          ...dovetailProject,
          id: "deleted",
          deleted: true,
          title: "private-deleted",
        },
      ],
      page: {
        total_count: 100,
        has_more: true,
        next_cursor: "https://untrusted.example",
      },
    }),
  ).toEqual({
    label: "Showing 1 active projects from first page",
    items: [{ id: "research-1", label: "Research" }],
  });
  expect(
    projectDovetailProjects({
      data: [{ ...dovetailProject, title: "" }],
      page: dovetailPage,
    }),
  ).toMatchObject({ items: [{ label: "(Untitled project)" }] });
  expect(
    projectDovetailProjects({
      data: [],
      page: { ...dovetailPage, total_count: 0 },
    }),
  ).toMatchObject({ items: [] });
});
it.each([
  {
    data: [dovetailProject, dovetailProject],
    page: { ...dovetailPage, total_count: 2 },
  },
  { data: [{ ...dovetailProject, id: "bad\nid" }], page: dovetailPage },
  { data: [{ ...dovetailProject, title: "bad\nname" }], page: dovetailPage },
  { data: [{ ...dovetailProject, type: "note" }], page: dovetailPage },
  { data: [{ ...dovetailProject, deleted: "false" }], page: dovetailPage },
  { data: [dovetailProject], page: { ...dovetailPage, total_count: 0 } },
  { data: [dovetailProject], page: { ...dovetailPage, has_more: true } },
  {
    data: [dovetailProject],
    page: { ...dovetailPage, next_cursor: "unexpected" },
  },
  { data: [dovetailProject], page: dovetailPage, errors: [] },
  { data: [dovetailProject], page: dovetailPage, error: "denied" },
  {
    data: Array.from({ length: 21 }, (_, i) => ({
      ...dovetailProject,
      id: String(i),
    })),
    page: { ...dovetailPage, total_count: 21 },
  },
])("rejects malformed or contradictory Dovetail replies %#", (body) => {
  expect(() => projectDovetailProjects(body)).toThrow();
});
