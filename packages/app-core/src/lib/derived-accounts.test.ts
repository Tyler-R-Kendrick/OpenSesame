/** A derived password across the readers that cannot prompt, and the one that can (ADR 0173). */

import {
  type AccountItem,
  accountPlainPassword,
  passwordMethod,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { readMethodPassword } from "./account-password.js";
import {
  derivedAccount,
  pepperedDerivedAccount,
  plainAccount,
} from "./account.test-support.js";
import { assignField } from "./live/field-write.js";
import { accountCredentials } from "./vault/export/cxf-account.js";
import { buildHealthReport } from "./vault/health.js";
import { mergeAccounts } from "./vault/import/merge-accounts.js";
import { graftAccountFormatOne } from "./vault/store-sync-account.js";

function methodOf(item: AccountItem) {
  const method = passwordMethod(item);
  if (method === undefined) throw new Error("fixture");
  return method;
}

describe("a derived password, read without a prompt", () => {
  it("is computed from the root, which is never the password", () => {
    const item = derivedAccount("Bank");
    const password = accountPlainPassword(item);
    expect(password).toHaveLength(20);
    expect(password).not.toBe(methodOf(item).secret);
    expect(accountPlainPassword(item)).toBe(password);
  });

  it("changes with the counter and not with another account's root", () => {
    const first = derivedAccount("Bank", 0);
    const rotated = derivedAccount("Bank", 1, methodOf(first).secret);
    const other = derivedAccount("Bank", 0);
    expect(accountPlainPassword(rotated)).not.toBe(accountPlainPassword(first));
    expect(accountPlainPassword(other)).not.toBe(accountPlainPassword(first));
  });

  it("is scored by health as the computed password, and a peppered one is unchecked", async () => {
    const report = buildHealthReport([
      derivedAccount("A"),
      await pepperedDerivedAccount("B", "pepper"),
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

describe("a derived password, read where a person can be asked", () => {
  it("answers with nothing asked while its root is in the clear", async () => {
    const item = derivedAccount("Bank");
    let asked = 0;
    const reading = await readMethodPassword(item, methodOf(item), async () => {
      asked += 1;
      return "x";
    });
    expect(reading).toEqual({
      status: "ok",
      password: accountPlainPassword(item),
    });
    expect(asked).toBe(0);
  });

  it("asks once for the pepper and computes the password from the root it opens", async () => {
    const peppered = await pepperedDerivedAccount("Bank", "pepper");
    const sealedMethod = methodOf(peppered);
    expect(sealedMethod.secret).toBe("");
    let asked = 0;
    const reading = await readMethodPassword(
      peppered,
      sealedMethod,
      async () => {
        asked += 1;
        return "pepper";
      },
    );
    expect(asked).toBe(1);
    expect(reading.status).toBe("ok");
    expect(reading.status === "ok" ? reading.password : "").toHaveLength(20);
  });

  it("refuses a wrong pepper, is absent with no way to ask, and honours a cancel", async () => {
    const item = await pepperedDerivedAccount("Bank", "pepper");
    const method = methodOf(item);
    expect(await readMethodPassword(item, method, async () => "nope")).toEqual({
      status: "wrong",
    });
    expect(await readMethodPassword(item, method)).toEqual({
      status: "absent",
    });
    expect(await readMethodPassword(item, method, async () => null)).toEqual({
      status: "cancelled",
    });
  });
});

describe("a derived password at the other seams", () => {
  it("exports the computed password to CXF, never the root, and withholds a peppered one", async () => {
    const item = derivedAccount("Bank");
    const { credentials, withheld } = accountCredentials(item);
    const document = JSON.stringify(credentials);
    expect(withheld).toBe(0);
    expect(document).toContain(accountPlainPassword(item));
    expect(document).not.toContain(methodOf(item).secret);
    const peppered = accountCredentials(
      await pepperedDerivedAccount("Bank", "pepper"),
    );
    expect(peppered.withheld).toBe(1);
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
      assignField(derivedAccount("Bank"), "password", "x", async () => "p"),
    ).rejects.toMatchObject({ reason: "computed" });
  });

  it("leaves the root alone when a first-format entry lays a password over it", () => {
    const current = derivedAccount("Bank");
    const incoming = plainAccount("Bank", "typed-over");
    const grafted = graftAccountFormatOne(current, incoming);
    expect(methodOf(grafted)).toEqual(methodOf(current));
    expect(accountPlainPassword(grafted)).toBe(accountPlainPassword(current));
  });
});
