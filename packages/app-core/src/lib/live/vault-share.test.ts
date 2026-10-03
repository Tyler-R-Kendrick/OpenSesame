/** What an owner's vault shows a live session, and what it will answer. */
import { createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { vaultCatalog, vaultField } from "./vault-share.js";

function vault() {
  const github = createItem("login", "GitHub");
  github.username = "octo";
  github.password = "hunter2";
  github.notes = "recovery: 1234";
  github.fields = [
    { id: "pin", name: "PIN", value: "0000", hidden: true },
    { id: "team", name: "Team", value: "design", hidden: false },
  ];
  const bank = createItem("login", "Bank");
  bank.password = "s3cret";
  const gone = createItem("login", "Deleted");
  gone.password = "old";
  gone.deletedAt = new Date().toISOString();
  return { items: [github, bank, gone], github, bank };
}

describe("the catalog", () => {
  it("carries names and unconcealed fields, and nothing concealed", () => {
    const { items } = vault();
    const catalog = vaultCatalog({
      title: "Team",
      policy: "read",
      expiresAt: 1,
      scope: { kind: "vault" },
      items: () => items,
    });
    expect(catalog.items.map((item) => item.name)).toEqual(["GitHub", "Bank"]);
    const wire = JSON.stringify(catalog);
    for (const secret of ["hunter2", "s3cret", "recovery: 1234", "0000", "old"])
      expect(wire).not.toContain(secret);
    const github = catalog.items[0]?.fields ?? [];
    expect(github.find((field) => field.key === "username")?.value).toBe(
      "octo",
    );
    expect(github.find((field) => field.key === "custom:team")?.value).toBe(
      "design",
    );
    expect(github.find((field) => field.key === "password")?.concealed).toBe(
      true,
    );
    expect(github.find((field) => field.key === "notes")?.concealed).toBe(true);
  });

  it("reaches only the chosen items", () => {
    const { items, bank } = vault();
    const catalog = vaultCatalog({
      title: "One",
      policy: "use",
      expiresAt: 1,
      scope: { kind: "items", ids: [bank.id] },
      items: () => items,
    });
    expect(catalog.items.map((item) => item.name)).toEqual(["Bank"]);
  });
});

describe("a field on request", () => {
  it("answers from the vault as it stands, inside the scope only", async () => {
    const { items, github, bank } = vault();
    const scope = { kind: "items" as const, ids: [github.id] };
    const read = vaultField({ scope, items: () => items });
    expect(await read(github.id, "password")).toBe("hunter2");
    expect(await read(github.id, "custom:pin")).toBe("0000");
    expect(await read(bank.id, "password")).toBeNull();
    expect(await read(github.id, "nope")).toBeNull();
    github.password = "rotated";
    expect(await read(github.id, "password")).toBe("rotated");
  });
});
