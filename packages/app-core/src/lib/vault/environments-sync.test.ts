/**
 * Environment cells through the sealed-store bridge (ADR 0188): an item that
 * is a key comes back from its entry as one, an entry written before
 * environments existed cannot erase an item's cells, and a trailer that
 * claims anything else is read as the cells it validly describes.
 */

import type { JsonObject } from "@opensesame/os-domain";
import { type SecretItem, createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { entryToVaultItem, itemToStoreEntry } from "./store-sync-codec.js";
import { type OsMeta, parseTrailerMeta } from "./store-sync-entry.js";
import { graftOnto } from "./store-sync-values.js";

function key(): SecretItem {
  const item = createItem("secret", "Stripe key");
  if (item.kind !== "secret") throw new Error("not a secret");
  return {
    ...item,
    environments: {
      staging: { value: "sk_test", required: true },
      production: {},
    },
  };
}

describe("environments through the sealed store", () => {
  it("round-trip an item that is a key, cells and all", () => {
    const entry = itemToStoreEntry(key(), []);
    const back = entryToVaultItem(entry);
    expect(back.environments).toEqual({
      staging: { value: "sk_test", required: true },
      production: {},
    });
  });

  it("carry nothing for an item that is not a key", () => {
    const plain = createItem("secret", "Plain");
    const entry = itemToStoreEntry(plain, []);
    expect(entry.trailer).not.toContain("environments");
    expect(entryToVaultItem(entry).environments).toBeUndefined();
  });

  it("do not let an entry that never knew them erase an item's own", () => {
    const current = key();
    const entry = itemToStoreEntry(createItem("secret", "Stripe key"), []);
    const incoming = entryToVaultItem(entry);
    expect(incoming.environments).toBeUndefined();
    const merged = graftOnto(current, incoming, true);
    expect(merged.environments).toEqual(current.environments);
  });

  it("let an entry that does carry them replace an item's own", () => {
    const current = key();
    const changed: SecretItem = {
      ...current,
      environments: { production: { value: "sk_live" } },
    };
    const merged = graftOnto(
      current,
      entryToVaultItem(itemToStoreEntry(changed, [])),
      true,
    );
    expect(merged.environments).toEqual({ production: { value: "sk_live" } });
  });

  it("read only the valid cells of a hand-edited trailer", () => {
    const entry = itemToStoreEntry(key(), []);
    const hostile: JsonObject = {
      staging: { value: 42, required: "yes" },
      "../etc/passwd": { value: "x" },
      Production: { value: "x" },
      qa: "not a cell",
      ok: { value: "kept", required: true, extra: "dropped" },
    };
    const meta: OsMeta = {
      ...parseTrailerMeta(entry.trailer),
      environments: hostile,
    };
    const back = entryToVaultItem({
      ...entry,
      trailer: `${JSON.stringify(meta)}\n`,
    });
    expect(back.environments).toEqual({
      staging: {},
      ok: { value: "kept", required: true },
    });
  });
});
