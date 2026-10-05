/**
 * How a new draft is seeded before the person has touched anything.
 *
 * Two questions, kept out of the form because they are not the form's: which
 * type this draft is (the route's, or the first this installation may create),
 * and what the link may fill in. Link values are refused on anything secret,
 * and that refusal is the error the form opens with.
 */
import { defaultCreatableKind } from "@opensesame/app-core/lib/item-kinds.js";
import {
  newItemDraft,
  prefillNewDraft,
} from "@opensesame/app-core/lib/vault/new-draft.js";
import type { VaultItem } from "@opensesame/vault-core";

export type SeededDraft = {
  readonly item: VaultItem | null;
  readonly error: string | null;
};

/**
 * `existing` is the record being edited, or null when creating. A creation
 * route names its own kind; a bare `/vault/new` does not, and must not invent
 * one: a device whose plan excludes account would otherwise open on an account
 * draft wearing an account draft's generated name.
 */
export function seedDraft(
  mode: "new" | "edit",
  existing: VaultItem | undefined,
  kindParam: string | undefined,
  search: URLSearchParams,
): SeededDraft {
  if (mode === "edit") return { item: existing ?? null, error: null };
  const kind = kindParam ?? defaultCreatableKind();
  try {
    return { item: prefillNewDraft(kind, search), error: null };
  } catch {
    return {
      item: newItemDraft(kind),
      error:
        "Link values were refused. Use public metadata parameters or supported field.<id> values; never put secrets in links.",
    };
  }
}
