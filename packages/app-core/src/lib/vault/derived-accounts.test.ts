/** A derived password across every seam that produces one (ADR 0173, 0174). */

import {
  type AccountItem,
  completePassword,
  passwordMethod,
  produceAccountPassword,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  derivedAccount,
  pepperedAccount,
  pepperedDerivedAccount,
  plainAccount,
  producedPassword,
} from "../account.test-support.js";
import { assignField } from "../live/field-write.js";
import { accountCredentials } from "./export/cxf-account.js";
import { buildHealthReport } from "./health.js";
import { mergeAccounts } from "./import/merge-accounts.js";
import { graftAccountFormatOne } from "./store-sync-account.js";

function methodOf(item: AccountItem) {
  const method = passwordMethod(item);
  if (method === undefined) throw new Error("fixture");
  return method;
}

describe("a derived password, produced", () => {
  it("is computed from the root, which is never the password", () => {
    const item = derivedAccount("Bank");
    const password = producedPassword(item);
    expect(password).toHaveLength(20);
    expect(password).not.toBe(methodOf(item).secret);
    expect(producedPassword(item)).toBe(password);
  });

  it("changes with the counter and not with another account's root", () => {
    const first = derivedAccount("Bank", 0);
    const rotated = derivedAccount("Bank", 1, methodOf(first).secret);
    const other = derivedAccount("Bank", 0);
    expect(producedPassword(rotated)).not.toBe(producedPassword(first));
    expect(producedPassword(other)).not.toBe(producedPassword(first));
  });

  it("leaves a slot for a pepper it is never given", () => {
    expect(producedPassword(derivedAccount("Bank"))).toHaveLength(20);
    const item = pepperedDerivedAccount("Bank", "-4");
    const produced = produceAccountPassword(item);
    expect(produced.status).toBe("slotted");
    expect(completePassword(produced)).toBeNull();
    if (produced.status !== "slotted") return;
    expect(produced.head).toHaveLength(16);
    expect(produced.tail).toHaveLength(4);
    expect(JSON.stringify(item)).not.toMatch(/pepper"?:\s*"[^"]/);
  });
});

describe("health", () => {
  it("scores the computed password, and leaves a pepper-slotted one unchecked", () => {
    const report = buildHealthReport([
      derivedAccount("A"),
      pepperedDerivedAccount("B"),
    ]);
    expect(report.unchecked).toBe(1);
    expect(report.counts.weak).toBe(0);
    expect(report.counts.reused).toBe(0);
  });

  it("is reused when two accounts compute the same password", () => {
    const one = derivedAccount("A");
    const two = derivedAccount("B", 0, methodOf(one).secret);
    expect(buildHealthReport([one, two]).counts.reused).toBe(2);
  });
});

describe("a derived password at the other seams", () => {
  it("is withheld from CXF, which has no field for parameters, and never exported as a generated password", () => {
    const item = derivedAccount("Bank");
    const { credentials, withheld } = accountCredentials(item);
    const document = JSON.stringify(credentials);
    expect(withheld).toBe(1);
    expect(document).not.toContain(producedPassword(item));
    expect(document).not.toContain(methodOf(item).secret);
    expect(accountCredentials(pepperedDerivedAccount("Bank")).withheld).toBe(1);
  });

  it("exports a stored password whole, and withholds one that has a pepper slot", () => {
    expect(accountCredentials(plainAccount("Mail", "kept")).withheld).toBe(0);
    expect(accountCredentials(pepperedAccount("Mail", "kept")).withheld).toBe(
      1,
    );
  });

  it("merges by the computed password: the same root and counter is one, another counter conflicts", () => {
    const existing = derivedAccount("Bank", 0);
    const root = methodOf(existing).secret;
    const same = mergeAccounts(existing, derivedAccount("Bank", 0, root));
    expect(same.duplicates).toHaveLength(1);
    const rotated = mergeAccounts(existing, derivedAccount("Bank", 1, root));
    expect(rotated.conflicts).toHaveLength(1);
    expect(rotated.account.methods).toHaveLength(1);
  });

  it("refuses to write a password a derived method computes", async () => {
    await expect(
      assignField(derivedAccount("Bank"), "password", "x"),
    ).rejects.toMatchObject({ reason: "computed" });
  });

  it("leaves the root alone when a first-format entry lays a password over it", () => {
    const current = derivedAccount("Bank");
    const incoming = plainAccount("Bank", "typed-over");
    const grafted = graftAccountFormatOne(current, incoming);
    expect(methodOf(grafted)).toEqual(methodOf(current));
    expect(producedPassword(grafted)).toBe(producedPassword(current));
  });
});
