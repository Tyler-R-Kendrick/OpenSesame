import {
  installItemType,
  syncInstalledTypes,
  uninstallItemType,
} from "@opensesame/vault-core";
import {
  RESERVED_DIRECTORIES,
  builtinRegistry,
  directoryName,
} from "@opensesame/vault-item-types";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_ITEM_KINDS } from "./contributions.test-support.js";
import { itemKindsFrom, withTypeDirectories } from "./item-kinds.js";

function community(id: string, title: string, plural: string, ext: string) {
  return JSON.stringify({
    apiVersion: "opensesame.dev/v1alpha1",
    kind: "VaultItemType",
    metadata: { id, version: "1.0.0", publisher: "https://community.test" },
    spec: {
      title,
      plural,
      extension: ext,
      summary: "Installed at runtime.",
      categories: ["other"],
      sections: [
        {
          id: "main",
          title: "Main",
          fields: [{ id: "label", type: "string", label: "Label" }],
        },
      ],
      native: { secret: null, trailer: [{ key: "label", field: "label" }] },
      cxf: { credential: "custom-fields" },
      subtitle: ["label"],
      search: ["label"],
    },
  });
}

const kinds = itemKindsFrom(
  LEGACY_ITEM_KINDS.map(({ kind, label, segment, order }) => ({
    kind,
    label,
    segment,
    order,
  })),
);

afterEach(() => syncInstalledTypes(undefined));

describe("vault directories", () => {
  it("draws no directory for a type nobody installed or used", () => {
    expect(withTypeDirectories(kinds).map((row) => row.segment)).toEqual(
      kinds.map((row) => row.segment),
    );
  });

  it("gives every installed type its own directory, empty or not", () => {
    installItemType(
      community("resident-id", "Resident ID", "Resident IDs", ".rid"),
    );
    installItemType(community("boat", "Boat", "Boats", ".boat"));
    const added = withTypeDirectories(kinds).slice(kinds.length);
    expect(added).toEqual([
      { id: "boat", segment: "boats", label: "Boat", order: 100 },
      {
        id: "resident-id",
        segment: "resident-ids",
        label: "Resident ID",
        order: 101,
      },
    ]);
    expect(Math.max(...kinds.map((row) => row.order))).toBeLessThan(100);
  });

  it("drops the directory when the type is uninstalled and holds nothing", () => {
    installItemType(community("boat", "Boat", "Boats", ".boat"));
    uninstallItemType("boat");
    expect(withTypeDirectories(kinds).map((row) => row.id)).not.toContain(
      "boat",
    );
  });

  it("keeps a directory for every type the vault holds items of", () => {
    const rows = withTypeDirectories(kinds, [
      "login",
      "wifi",
      "typed",
      "from-elsewhere",
    ]);
    const added = rows.slice(kinds.length);
    expect(added.map((row) => [row.id, row.segment])).toEqual([
      ["from-elsewhere", "from-elsewhere"],
      ["wifi", "wi-fi-networks"],
    ]);
    // The platform kinds appear once, where they always were.
    expect(rows.filter((row) => row.id === "login")).toHaveLength(1);
  });

  it("never brings back a kind a capability owns", () => {
    const core = itemKindsFrom([]);
    const rows = withTypeDirectories(core, ["passkey", "certificate", "drop"]);
    expect(rows.map((row) => row.id)).toEqual(core.map((row) => row.id));
  });

  it("numbers a type not installed here rather than merge it into a taken directory", () => {
    const rows = withTypeDirectories(kinds, ["logins"]);
    expect(rows.at(-1)).toMatchObject({ id: "logins", segment: "logins-2" });
    const segments = rows.map((row) => row.segment);
    expect(new Set(segments).size).toBe(segments.length);
  });

  it("never draws a type not installed here over a fixed row", () => {
    const rows = withTypeDirectories(kinds, ["trash", "favorites", "notes"]);
    const added = rows.slice(kinds.length);
    // A filter id would open the filter, so it gets no directory; a reserved
    // directory name is numbered like any other taken one.
    expect(added.map((row) => [row.id, row.segment])).toEqual([
      ["notes", "notes-2"],
    ]);
  });

  it("holds each platform kind's directory as its type's or a reserved one", () => {
    // The registry refuses an install whose directory is another type's or
    // reserved; that only protects the rail if every name the rail draws for
    // a platform kind is one of the two.
    const registry = builtinRegistry();
    for (const row of kinds) {
      const definition = registry.get(row.id);
      expect(definition).toBeDefined();
      if (definition === undefined) continue;
      expect([directoryName(definition), ...RESERVED_DIRECTORIES]).toContain(
        row.segment,
      );
    }
  });

  it("refuses to install a type into a directory the rail already draws", () => {
    for (const row of kinds) {
      const outcome = installItemType(
        community(`x-${row.id}`, `Other ${row.id}`, row.segment, ".xx"),
      );
      expect(outcome.ok).toBe(false);
    }
  });
});
