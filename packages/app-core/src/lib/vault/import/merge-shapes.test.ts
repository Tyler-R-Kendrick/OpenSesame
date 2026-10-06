import { accountTotp, methodsOfType } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { producedPassword } from "../../account.test-support.js";
import { defaultMergeOptions, planMerge } from "./merge.js";
import { draftAccount, draftNote, draftSecret } from "./types.js";

describe("planMerge item shapes", () => {
  it("carries an account's fields and uris into the vault item", () => {
    const login = draftAccount("Mail");
    login.username = "ada";
    login.password = "hunter2";
    login.totp = "JBSWY3DPEHPK3PXP";
    login.fields = [
      { name: "Account number", value: "1234", hidden: false },
      { name: "PIN", value: "9876", hidden: true },
    ];
    login.uris = [
      { uri: "https://mail.example.com", match: "host" },
      { uri: "https://backup.example.com", match: "exact" },
    ];

    const plan = planMerge([login], [], [], defaultMergeOptions);
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0];
    if (item?.kind !== "account") throw new Error("expected account");
    expect(item.fields).toEqual([
      expect.objectContaining({
        name: "Account number",
        value: "1234",
        hidden: false,
      }),
      expect.objectContaining({ name: "PIN", value: "9876", hidden: true }),
    ]);
    // Field and URI ids are minted fresh at merge time, not reused.
    expect(item.fields[0]?.id).toBeTruthy();
    expect(item.uris.map((u) => u.match)).toEqual(["host", "exact"]);
    expect(accountTotp(item)).toBe("JBSWY3DPEHPK3PXP");
    expect(producedPassword(item)).toBe("hunter2");
  });

  it("lands an imported password as a manual, unpeppered method", () => {
    const draft = draftAccount("Mail");
    draft.password = "hunter2";
    draft.passwordChangedAt = "2020-01-01T00:00:00.000Z";
    const item = planMerge([draft], [], [], defaultMergeOptions).items[0];
    if (item?.kind !== "account") throw new Error("expected account");
    expect(item.methods).toEqual([
      {
        id: `${item.id}:password`,
        type: "password",
        generator: { id: "manual" },
        pepper: false,
        secret: "hunter2",
        changedAt: "2020-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("lands a seed with no password as an authenticator method alone", () => {
    const draft = draftAccount("Seed only");
    draft.totp = "JBSWY3DPEHPK3PXP";
    const item = planMerge([draft], [], [], defaultMergeOptions).items[0];
    if (item?.kind !== "account") throw new Error("expected account");
    expect(item.methods).toEqual([
      {
        id: `${item.id}:authenticator`,
        type: "authenticator",
        secret: "JBSWY3DPEHPK3PXP",
      },
    ]);
  });

  it("gives an account with nothing in it one empty password method", () => {
    const item = planMerge([draftAccount("Empty")], [], [], defaultMergeOptions)
      .items[0];
    if (item?.kind !== "account") throw new Error("expected account");
    expect(item.methods).toHaveLength(1);
    expect(item.methods[0]).toMatchObject({
      type: "password",
      secret: "",
      generator: { id: "manual" },
    });
  });

  it("lands every further method the export held, with its own id", () => {
    const draft = draftAccount("Service");
    draft.password = "pw-one";
    draft.totp = "JBSWY3DPEHPK3PXP";
    draft.methods = [
      { type: "password", secret: "pw-two" },
      { type: "authenticator", secret: "KRSXG5CTMVRXEZLU" },
      { type: "api-key", key: "key-1", header: "X-Api-Key" },
    ];
    const item = planMerge([draft], [], [], defaultMergeOptions).items[0];
    if (item?.kind !== "account") throw new Error("expected account");
    expect(methodsOfType(item, "password").map((m) => m.secret)).toEqual([
      "pw-one",
      "pw-two",
    ]);
    expect(methodsOfType(item, "authenticator")).toHaveLength(2);
    expect(methodsOfType(item, "api-key")).toEqual([
      expect.objectContaining({ key: "key-1", header: "X-Api-Key" }),
    ]);
    expect(new Set(item.methods.map((m) => m.id)).size).toBe(5);
  });

  it("lands a secret with an empty ceiling for the operator to fill", () => {
    const secret = draftSecret("Deploy webhook");
    secret.value = "whsec_123";
    const note = draftNote("Recovery");

    const plan = planMerge([secret, note], [], [], defaultMergeOptions);
    const landed = plan.items[0];
    if (landed?.kind !== "secret") throw new Error("expected secret");
    expect(landed.value).toBe("whsec_123");
    // An import never grants capability on its own.
    expect(landed.ceiling).toEqual([]);
    expect(landed.grantees).toEqual([]);
    expect(landed.connectionRef).toBe("");
    expect(plan.items[1]?.kind).toBe("note");
  });
});
