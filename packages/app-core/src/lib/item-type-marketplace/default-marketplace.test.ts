/**
 * Ours is the marketplace every device starts with, so it is held to what a
 * device will check when it reads it: the index parses, every pin matches the
 * committed bytes, every definition parses as a community type, and nothing
 * in it collides with a built-in or with itself. Re-pin after an edit with
 * `node scripts/pin-marketplace.mjs`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinRegistry, parseDefinition } from "@opensesame/vault-item-types";
import { describe, expect, it } from "vitest";
import { parseMarketplaceIndex } from "./marketplace-index.js";
import { INDEX_PATH } from "./source.js";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(repo, path), "utf8");

function index() {
  const parsed = parseMarketplaceIndex(read(INDEX_PATH));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.index;
}

describe("the default marketplace", () => {
  it("lists at least one type, every one pinned", () => {
    const { itemTypes } = index();
    expect(itemTypes.length).toBeGreaterThan(0);
    for (const entry of itemTypes) expect(entry.sha256).not.toBeNull();
  });

  it.each(index().itemTypes.map((entry) => [entry.path, entry.sha256]))(
    "%s matches its pin and parses as a community type",
    (path, pin) => {
      const text = read(path);
      expect(createHash("sha256").update(text).digest("hex")).toBe(pin);
      const parsed = parseDefinition(text, "community");
      expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    },
  );

  it("installs whole beside the built-ins, with no id or extension clash", () => {
    const registry = builtinRegistry();
    for (const entry of index().itemTypes) {
      const outcome = registry.install(read(entry.path), "vault");
      expect(outcome.ok ? [] : outcome.errors).toEqual([]);
    }
  });
});
