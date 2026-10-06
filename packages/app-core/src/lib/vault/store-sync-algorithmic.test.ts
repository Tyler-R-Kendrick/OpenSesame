import { passwordMethod } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  derivedAccount,
  pepperedAccount,
  pepperedDerivedAccount,
  producedPassword,
} from "../account.test-support.js";
import { entryToVaultItem, vaultItemToEntry } from "./store-sync.js";

function accountOf(item: ReturnType<typeof entryToVaultItem>) {
  if (item.kind !== "account") throw new Error("expected an account");
  return item;
}

describe("an account whose password an algorithm computes, as a store entry (ADR 0174)", () => {
  it("holds the parameters it is computed from and never the generated password", () => {
    const item = derivedAccount("Bank", 2);
    const generated = producedPassword(item);
    expect(generated).toHaveLength(20);
    const entry = vaultItemToEntry(item, []);
    expect(entry.secret).toBe("");
    expect(entry.trailer).not.toContain(generated);
    const meta = JSON.parse(entry.trailer);
    expect(meta.values.methods[0]).toMatchObject({
      type: "password",
      pepper: false,
      generator: { id: "derived", counter: 2 },
    });
    expect(meta.values.methods[0].generator.rules.length).toBe(20);
    expect(meta.values.methods[0].secret).toBe(passwordMethod(item)?.secret);
  });

  it("round-trips to the same password, and a re-import is a no-op", () => {
    const item = derivedAccount("Bank", 2);
    const entry = vaultItemToEntry(item, []);
    const back = accountOf(entryToVaultItem(entry));
    expect(producedPassword(back)).toBe(producedPassword(item));
    expect(passwordMethod(back)).toEqual(passwordMethod(item));
    expect(vaultItemToEntry(back, [])).toEqual(entry);
  });

  it("keeps where a pepper goes, and not the pepper", () => {
    const item = pepperedDerivedAccount("Bank", "-4");
    const entry = vaultItemToEntry(item, []);
    expect(entry.secret).toBe("");
    const back = accountOf(entryToVaultItem(entry));
    expect(passwordMethod(back)).toMatchObject({
      pepper: true,
      pepperAt: "-4",
    });
  });

  it("puts a stored password with a pepper slot on line one, and its position in the trailer", () => {
    const entry = vaultItemToEntry(pepperedAccount("Mail", "kept", "2"), []);
    expect(entry.secret).toBe("kept");
    expect(JSON.parse(entry.trailer).values.methods[0]).toMatchObject({
      pepper: true,
      pepperAt: "2",
    });
    expect(entry.trailer).not.toContain("kept");
  });

  it("does not let an edited line one overwrite the root an algorithm computes from", () => {
    const item = derivedAccount("Bank");
    const entry = { ...vaultItemToEntry(item, []), secret: "typed-in-pass" };
    const back = accountOf(entryToVaultItem(entry));
    expect(passwordMethod(back)?.secret).toBe(passwordMethod(item)?.secret);
  });
});
