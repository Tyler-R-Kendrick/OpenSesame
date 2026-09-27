import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RecipeResource,
  exportRecipe,
} from "../../lib/configuration/recipes.js";
import { LocalDirectoryError } from "../../lib/local-directory-types.js";
import {
  applyImportedRecipe,
  recipePanelSeams,
} from "./application-recipe-panel-model.js";

/** A store that, like the real one, accepts a write only at its revision. */
function revisionedStore(start: number) {
  const seen: number[] = [];
  const store = { stored: start, seen };
  vi.spyOn(recipePanelSeams, "configure").mockImplementation(
    async (_tomb, revision) => {
      store.seen.push(revision);
      if (revision !== store.stored) {
        throw new LocalDirectoryError(
          "Application configuration changed. Reload before saving.",
        );
      }
      store.stored += 1;
      return { version: 2, revision: store.stored, applications: [] };
    },
  );
  return store;
}

const application = (logicalId: string): RecipeResource => ({
  kind: "local_application",
  logicalId,
  body: { redirectUris: ["https://rp.example/cb"], scopes: ["openid"] },
});

const recipe = exportRecipe({
  name: "two",
  resources: [application("app-a"), application("app-b")],
});

const apply = (revision: number | undefined) =>
  applyImportedRecipe({
    imported: JSON.stringify(recipe),
    organization: "org-1",
    tomb: "tomb-1",
    revision,
    fallback: recipe,
  });

describe("applyImportedRecipe", () => {
  let store: ReturnType<typeof revisionedStore>;
  beforeEach(() => {
    store = revisionedStore(4);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes from the revision the panel was drawn from, then follows on", async () => {
    expect(await apply(4)).toEqual({
      message:
        "Applied app-a, app-b to org-1. Repeat import keeps the same applicationId.",
      revision: 6,
    });
    expect(store.seen).toEqual([4, 5]);
  });

  it("hands back the revision a repeat import must start from", async () => {
    const first = await apply(4);
    expect(await apply(first.revision)).toMatchObject({ revision: 8 });
    expect(store.seen).toEqual([4, 5, 6, 7]);
  });

  it("refuses to overwrite a change made since the panel was drawn", async () => {
    expect(await apply(3)).toEqual({
      message: "Application configuration changed. Reload before saving.",
    });
    expect(store.seen).toEqual([3]);
    expect(store.stored).toBe(4);
  });

  it("asks for an unlocked vault before writing anything", async () => {
    expect(await apply(undefined)).toEqual({
      message: "Unlock the vault before applying a recipe.",
    });
    expect(store.seen).toEqual([]);
  });
});
