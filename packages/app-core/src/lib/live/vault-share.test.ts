/** What an owner's vault shows a live session, and what it will answer. */
import { manualPassword } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { pepperedAccount, plainAccount } from "../account.test-support.js";
import { vaultCatalog, vaultField } from "./vault-share.js";

function vault() {
  const github = plainAccount("GitHub", "hunter2", {
    username: "octo",
    totp: "JBSWY3DPEHPK3PXP",
  });
  github.notes = "recovery: 1234";
  github.fields = [
    { id: "pin", name: "PIN", value: "0000", hidden: true },
    { id: "team", name: "Team", value: "design", hidden: false },
  ];
  const bank = plainAccount("Bank", "s3cret");
  const gone = plainAccount("Deleted", "old");
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
    for (const secret of [
      "hunter2",
      "s3cret",
      "recovery: 1234",
      "0000",
      "old",
      "JBSWY3DPEHPK3PXP",
    ])
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

  it("offers no password for a peppered account, sealed or otherwise", async () => {
    const peppered = await pepperedAccount(
      "Vaulted",
      "the-peppered-password",
      "pepper",
    );
    peppered.username = "ada";
    const catalog = vaultCatalog({
      title: "Team",
      policy: "read",
      expiresAt: 1,
      scope: { kind: "vault" },
      items: () => [peppered],
    });
    const fields = catalog.items[0]?.fields ?? [];
    expect(fields.map((field) => field.key)).toContain("username");
    expect(fields.map((field) => field.key)).not.toContain("password");
    const wire = JSON.stringify(catalog);
    expect(wire).not.toContain("the-peppered-password");
    expect(wire).not.toContain("ctB64");
    const read = vaultField({
      scope: { kind: "vault" },
      items: () => [peppered],
    });
    expect(await read(peppered.id, "password")).toBeNull();
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
    github.methods = [
      manualPassword(`${github.id}:password`, "rotated", github.createdAt),
    ];
    expect(await read(github.id, "password")).toBe("rotated");
  });
});
