import { expect, it } from "vitest";
import {
  invokeNativeApiResource,
  nativeApiResourceActions,
} from "./native-api-resources.js";
import {
  nativeServiceInventories,
  projectBrevoLists,
  projectLaunchDarklyProjects,
  projectSendgridLists,
} from "./native-api-service-inventories.js";
import { nativeAnswers } from "./native-api.test-support.js";

const listId = "abc12312-x3y4-1234-abcd-123qwe456rty";
const cases = [
  {
    id: "brevo",
    field: "lists",
    parse: projectBrevoLists,
    row: { id: 53, name: "Production contacts" },
    body: { count: 1, lists: [{ id: 53, name: "Production contacts" }] },
    empty: { count: 0, lists: [] },
    invalidCount: { count: 0 },
  },
  {
    id: "sendgrid",
    field: "result",
    parse: projectSendgridLists,
    row: { id: listId, name: "Newsletter" },
    body: {
      result: [{ id: listId, name: "Newsletter" }],
      _metadata: { count: 1 },
    },
    empty: { result: [], _metadata: { count: 0 } },
    invalidCount: { _metadata: { count: 0 } },
  },
  {
    id: "launchdarkly",
    field: "items",
    parse: projectLaunchDarklyProjects,
    row: { key: "project-owned", name: "Production" },
    body: {
      totalCount: 1,
      items: [{ key: "project-owned", name: "Production" }],
    },
    empty: { items: [], totalCount: 0 },
    invalidCount: { totalCount: 0 },
  },
];
it("registers exactly the three real inventories while preserving all eight prior consumer actions", () => {
  expect(nativeServiceInventories.map(({ providerId }) => providerId)).toEqual([
    "brevo",
    "sendgrid",
    "launchdarkly",
  ]);
  for (const resource of nativeServiceInventories) {
    expect(nativeApiResourceActions(resource.providerId, "api-key")).toEqual([
      { id: resource.id, label: resource.label },
    ]);
    expect(nativeApiResourceActions(resource.providerId, "oauth")).toEqual([]);
  }
  for (const id of [
    "buildkite",
    "circleci",
    "digitalocean",
    "doppler",
    "neon",
    "pinecone",
    "n8n",
    "mailgun",
  ])
    expect(nativeApiResourceActions(id, "api-key")).toHaveLength(1);
});
it.each(cases)(
  "$id accepts an explicit genuine empty collection without manufacturing an item",
  ({ parse, empty }) => {
    expect(parse(empty)).toMatchObject({ items: [] });
  },
);
it.each(cases)(
  "$id rejects failed envelopes even alongside valid collection data",
  ({ parse, body }) => {
    for (const failure of [
      { error: { message: "denied" } },
      { errors: ["denied"] },
      { code: "Forbidden" },
      { message: "denied" },
      { success: false },
      { ok: false },
      { status: "error" },
    ])
      expect(() => parse({ ...body, ...failure })).toThrow();
  },
);
it.each(cases)(
  "$id rejects missing, duplicate, malformed or oversized collection data",
  ({ id, field, parse, body, row }) => {
    expect(() => parse({ malformed: true })).toThrow();
    expect(() => parse({ ...body, [field]: null })).toThrow();
    expect(() => parse({ [field]: [row, row] })).toThrow();
    expect(() =>
      parse({ ...body, [field]: [{ ...row, name: "bad\nlabel" }] }),
    ).toThrow();
    const identity = id === "launchdarkly" ? "key" : "id";
    for (const value of id === "brevo"
      ? [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "53"]
      : ["", "bad\nID", "x".repeat(257)])
      expect(() =>
        parse({ ...body, [field]: [{ ...row, [identity]: value }] }),
      ).toThrow();
    const oversized = Array.from({ length: 21 }, (_, index) => ({
      ...row,
      [identity]:
        id === "brevo"
          ? index
          : id === "sendgrid"
            ? String(index).padStart(36, "0")
            : `project-${index}`,
    }));
    expect(() => parse({ [field]: oversized })).toThrow();
  },
);
it.each(cases)(
  "$id refuses inconsistent, nonfinite or partial pagination counts",
  ({ parse, body, invalidCount }) => {
    expect(() => parse({ ...body, ...invalidCount })).toThrow();
    const countKey =
      "count" in invalidCount
        ? "count"
        : "totalCount" in invalidCount
          ? "totalCount"
          : "_metadata";
    for (const value of [
      -1,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() =>
        parse({
          ...body,
          [countKey]: countKey === "_metadata" ? { count: value } : value,
        }),
      ).toThrow();
  },
);
it("Brevo keeps only list ID/name and does not depend on deprecated subscriber totals", () => {
  expect(
    projectBrevoLists({
      count: 20,
      lists: [
        {
          id: 53,
          name: "Production contacts",
          totalSubscribers: 0,
          totalBlacklisted: 0,
          folderId: 1,
          contacts: [{ email: "private-contact" }],
        },
      ],
    }),
  ).toEqual({
    label: "Showing 1 contact lists from first page",
    items: [{ id: "53", label: "Production contacts" }],
  });
  expect(
    projectBrevoLists({
      lists: [{ id: Number.MAX_SAFE_INTEGER, name: "Owned" }],
    }).items[0]?.id,
  ).toBe(String(Number.MAX_SAFE_INTEGER));
});
it("SendGrid preserves the official nonhex ID example and drops counts and arbitrary pagination links", () => {
  expect(
    projectSendgridLists({
      result: [
        {
          id: listId,
          name: "Newsletter",
          contact_count: 500,
          _metadata: { self: "https://discard.example" },
        },
      ],
      _metadata: { count: 21, next: "https://discard.example?api_key=private" },
    }),
  ).toEqual({
    label: "Showing 1 marketing lists from first page",
    items: [{ id: listId, label: "Newsletter" }],
  });
  expect(() =>
    projectSendgridLists({ result: [{ id: "x".repeat(35), name: "Wrong" }] }),
  ).toThrow();
  expect(() =>
    projectSendgridLists({ result: [{ id: "x".repeat(37), name: "Wrong" }] }),
  ).toThrow();
});
it("LaunchDarkly projects project key/name while discarding environment rules and SDK keys", () => {
  expect(
    projectLaunchDarklyProjects({
      items: [
        {
          key: "owned",
          name: "Production",
          environments: [
            { apiKey: "private-sdk-key", rules: ["private-rule"] },
          ],
          _access: { denied: ["private-access"] },
          _links: { self: { href: "https://discard.example" } },
        },
      ],
      totalCount: 21,
    }),
  ).toEqual({
    label: "Showing 1 projects from first page",
    items: [{ id: "owned", label: "Production" }],
  });
});
it.each(cases)(
  "$id accepts a full first page of twenty distinct resources and never expands it",
  ({ id, field, parse }) => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...(id === "launchdarkly"
        ? { key: `project-${index}` }
        : { id: id === "brevo" ? index : String(index).padStart(36, "0") }),
      name: `Owned ${index}`,
    }));
    const result = parse({ [field]: rows });
    expect(result.items).toHaveLength(20);
    expect(result.items[19]?.label).toBe("Owned 19");
  },
);
it("refuses caller-selected request/auth/target overrides and mismatched provider dispatch before HTTP", async () => {
  const { transport, fetch } = nativeAnswers();
  for (const resource of nativeServiceInventories) {
    for (const field of [
      "url",
      "query",
      "page_size",
      "limit",
      "api_key",
      "body",
      "project",
    ])
      await expect(
        resource.read("not-saved", { [field]: "override" }, transport),
      ).rejects.toThrow("does not accept");
    expect(
      invokeNativeApiResource(
        "telegram",
        "not-saved",
        resource.id,
        {},
        transport,
      ),
    ).toBeNull();
  }
  expect(fetch).not.toHaveBeenCalled();
});
