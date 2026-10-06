import { overlapCast } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  legacySealedAccount,
  pepperedAccount,
  plainAccount,
} from "../account.test-support.js";
import type { EncryptionPlan, ExecutionPermit } from "./plan.js";
import type { SopsRunner } from "./runner.js";
import { exportVaultSecrets, importVaultSecrets } from "./vault-secrets.js";

const plan: EncryptionPlan = overlapCast({ format: "json" });
const permit: ExecutionPermit = overlapCast({});

/** Encrypts to its own plaintext: enough to see what a document would carry. */
const runner: SopsRunner = overlapCast({
  encryptNew: async (text: string) => text,
  inspect: async () => ({ keyGroups: [] }),
  open: async (text: string) => ({ handle: "h", plaintext: text }),
  dispose: () => undefined,
});

describe("a vault-secrets document", () => {
  it("carries an account's plain password and seed", async () => {
    const account = plainAccount("GitHub", "hunter2", {
      username: "octo",
      totp: "JBSWY3DPEHPK3PXP",
    });
    const document = await exportVaultSecrets({
      runner,
      items: [account],
      plan,
      permit,
    });
    const back = await importVaultSecrets({
      runner,
      ciphertext: document,
      identities: [],
      consentToVaultCopy: false,
      permit,
    });
    expect(back.items).toEqual([account]);
  });

  it("treats a password an older version sealed as absent: not exported, not counted as a value", async () => {
    const peppered = await legacySealedAccount(
      "Vaulted",
      "the-peppered-password",
      "pepper",
    );
    peppered.username = "ada";
    let omitted = 0;
    const document = await exportVaultSecrets({
      runner,
      items: [peppered, plainAccount("Plain", "kept-password")],
      plan,
      permit,
      onOmitted: (count) => {
        omitted = count;
      },
    });
    expect(omitted).toBe(1);
    expect(document).not.toContain("the-peppered-password");
    // Neither the sealed envelope nor its key derivation leaves.
    expect(document).not.toContain("ctB64");
    expect(document).not.toContain("PBKDF2");
    expect(document).toContain("kept-password");
    const back = await importVaultSecrets({
      runner,
      ciphertext: document,
      identities: [],
      consentToVaultCopy: false,
      permit,
    });
    const vaulted = back.items.find((item) => item.name === "Vaulted");
    expect(vaulted?.kind === "account" ? vaulted.methods : null).toEqual([]);
    expect(vaulted?.kind === "account" ? vaulted.username : "").toBe("ada");
  });

  it("exports a password with a pepper slot as the stored password and its position, never a pepper", async () => {
    const slotted = pepperedAccount("Slotted", "kept-base-password", "-3");
    const document = await exportVaultSecrets({
      runner,
      items: [slotted],
      plan,
      permit,
      onOmitted: () => undefined,
    });
    const back = await importVaultSecrets({
      runner,
      ciphertext: document,
      identities: [],
      consentToVaultCopy: false,
      permit,
    });
    const item = back.items.find((entry) => entry.name === "Slotted");
    const method = item?.kind === "account" ? item.methods[0] : undefined;
    expect(method).toMatchObject({
      type: "password",
      pepper: true,
      pepperAt: "-3",
      secret: "kept-base-password",
    });
  });

  it("opens a document written before accounts, and its logins become accounts", async () => {
    const legacy = {
      ...createItem("note", "x"),
      id: "legacy-1",
      kind: "login",
      name: "Old login",
      username: "octo",
      password: "hunter2",
      totp: "JBSWY3DPEHPK3PXP",
      uris: [],
      passwordChangedAt: "2026-01-01T00:00:00.000Z",
    };
    const back = await importVaultSecrets({
      runner,
      ciphertext: JSON.stringify({ items: [legacy] }),
      identities: [],
      consentToVaultCopy: false,
      permit,
    });
    const [item] = back.items;
    expect(item?.kind).toBe("account");
    if (item?.kind !== "account") return;
    expect(item.methods.map((method) => method.type)).toEqual([
      "password",
      "authenticator",
    ]);
  });

  it("refuses an account whose methods are not a list", async () => {
    const account = { ...plainAccount("Bad", "x"), methods: "oops" };
    await expect(
      importVaultSecrets({
        runner,
        ciphertext: JSON.stringify({ items: [account] }),
        identities: [],
        consentToVaultCopy: false,
        permit,
      }),
    ).rejects.toThrow(/login methods/);
  });
});
