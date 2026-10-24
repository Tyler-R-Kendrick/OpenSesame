import { expect, it } from "vitest";
import { projectLemmaEntities } from "./native-api-catalog-resources.js";
import { nativeApiResourceActions } from "./native-api-resources.js";

const entity = {
  id: "entity_k7mXp2vR9nTfBw4s",
  name: "Riverside Family Medicine",
};
const page = { has_next: false, cursor: null };
it("exposes the useful entity read only through the existing API-key action registry", () => {
  expect(nativeApiResourceActions("lemma", "api-key")).toEqual([
    { id: "provider.entities.read", label: "List entities" },
  ]);
  expect(nativeApiResourceActions("lemma", "oauth")).toEqual([]);
  expect(nativeApiResourceActions("dovetail", "api-key")).toEqual([
    { id: "provider.projects.read", label: "List projects" },
  ]);
});
it("projects only entity IDs and names without medical, financial or cursor data", () => {
  expect(
    projectLemmaEntities({
      data: [
        {
          ...entity,
          npi: "1234567890",
          structure: "professional_llc",
          address: { line1: "private-street" },
          balance: "private-balance",
        },
      ],
      has_next: true,
      cursor: "https://untrusted.example/next",
    }),
  ).toEqual({
    label: "Showing 1 entities from first page",
    items: [{ id: entity.id, label: entity.name }],
  });
  expect(projectLemmaEntities({ data: [], ...page })).toEqual({
    label: "Showing 0 entities from first page",
    items: [],
  });
});
it.each([
  { data: [entity, entity], ...page },
  { data: [{ ...entity, id: "unrelated" }], ...page },
  { data: [{ ...entity, id: "entity_bad\nid" }], ...page },
  { data: [{ ...entity, id: `entity_${"x".repeat(256)}` }], ...page },
  { data: [{ ...entity, name: "" }], ...page },
  { data: [{ ...entity, name: "bad\nname" }], ...page },
  { data: [entity], has_next: true, cursor: null },
  { data: [entity], has_next: false, cursor: "unexpected" },
  { data: [entity], has_next: true, cursor: "" },
  { data: [entity], has_next: "true", cursor: "next" },
  { data: [entity], ...page, errors: [] },
  { data: [entity], ...page, error: "denied" },
  {
    data: Array.from({ length: 21 }, (_, i) => ({
      ...entity,
      id: `entity_${i}`,
    })),
    ...page,
  },
])(
  "rejects malformed entity identity, pagination or error envelopes %#",
  (body) => {
    expect(() => projectLemmaEntities(body)).toThrow();
  },
);
