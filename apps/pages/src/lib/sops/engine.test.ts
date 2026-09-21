/** @vitest-environment node */
import * as age from "age-encryption";
import { describe, expect, it } from "vitest";
import {
  decryptSopsDocument,
  encryptSopsDocument,
  inspectSopsDocument,
} from "./engine.js";
import { shamirCombine, shamirSplit } from "./shamir.js";
import { exportVaultSecrets, importVaultSecrets } from "./vault-secrets.js";

describe("browser SOPS", () => {
  it("round-trips YAML and JSON with a local age identity", async () => {
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const yaml = await encryptSopsDocument({
      format: "yaml",
      plaintext: "hello: world\ncount: 2\nnote_unencrypted: visible\n",
      recipients: [recipient],
      now: new Date("2026-09-21T12:00:00Z"),
    });
    expect(yaml).not.toMatch(/OPENSESAME_SOPS_BIN/);
    expect(yaml).toMatch(/ENC\[AES256_GCM,/);
    expect(yaml).toMatch(/note_unencrypted: visible/);
    const opened = await decryptSopsDocument({
      format: "yaml",
      ciphertext: yaml,
      identity,
    });
    expect(opened).toMatch(/hello: world/);
    expect(opened).toMatch(/count: ["']?2/);
    expect(inspectSopsDocument(yaml, "yaml").encrypted).toBe(true);

    const json = await encryptSopsDocument({
      format: "json",
      plaintext: '{"10":"a","2":"b","name":"ada"}',
      recipients: [recipient],
      now: new Date("2026-09-21T12:00:00Z"),
    });
    const jsonOpened = await decryptSopsDocument({
      format: "json",
      ciphertext: json,
      identity,
    });
    expect(jsonOpened.indexOf('"10"')).toBeLessThan(jsonOpened.indexOf('"2"'));
    expect(jsonOpened).toMatch(/"name":"ada"/);
  });

  it("refuses a MAC mismatch and a wrong identity", async () => {
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const yaml = await encryptSopsDocument({
      format: "yaml",
      plaintext: "hello: world\n",
      recipients: [recipient],
    });
    const other = await age.generateX25519Identity();
    await expect(
      decryptSopsDocument({
        format: "yaml",
        ciphertext: yaml,
        identity: other,
      }),
    ).rejects.toThrow(/identity|groups/i);
    const tampered = yaml.replace(
      /ENC\[AES256_GCM,[^\]]+\]/,
      "ENC[AES256_GCM,data:AA==,iv:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,tag:AAAAAAAAAAAAAAAAAAAAAA==,type:str]",
    );
    await expect(
      decryptSopsDocument({ format: "yaml", ciphertext: tampered, identity }),
    ).rejects.toThrow();
  });

  it("shamir shares are 33 bytes and two-of-three reconstruct", () => {
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    const shares = shamirSplit(secret, 3, 2);
    const first = shares[0];
    const third = shares[2];
    if (!first || !third) throw new Error("missing shares");
    expect(first.byteLength).toBe(33);
    const opened = shamirCombine([first, third]);
    expect(opened).toEqual(secret);
    expect(() => shamirCombine([first, first])).toThrow(/duplicate/);
  });

  it("exports every vault secret and imports them back", async () => {
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const item = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "secret" as const,
      name: "api",
      folderId: null,
      favorite: false,
      notes: "",
      fields: [],
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
      deletedAt: null,
      value: "synthetic-secret",
      ceiling: [],
      grantees: [],
      connectionRef: "",
    };
    const file = await exportVaultSecrets({
      items: [item],
      recipients: [recipient],
    });
    expect(file).toMatch(/ENC\[AES256_GCM,/);
    expect(file).not.toMatch(/synthetic-secret/);
    const opened = await importVaultSecrets({
      ciphertext: file,
      identity,
      consentToVaultCopy: false,
    });
    const openedItem = opened[0];
    if (!openedItem || openedItem.kind !== "secret") {
      throw new Error("missing secret");
    }
    expect(openedItem.value).toBe("synthetic-secret");
  });

  it("refuses a vault import that adds a field outside the item", async () => {
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const file = await encryptSopsDocument({
      format: "json",
      plaintext: JSON.stringify({
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            kind: "secret",
            name: "api",
            folderId: null,
            favorite: false,
            notes: "",
            fields: [],
            createdAt: "2026-09-21T00:00:00.000Z",
            updatedAt: "2026-09-21T00:00:00.000Z",
            deletedAt: null,
            value: "synthetic-secret",
            ceiling: [],
            grantees: [],
            connectionRef: "",
            admin: true,
          },
        ],
      }),
      recipients: [recipient],
    });
    await expect(
      importVaultSecrets({
        ciphertext: file,
        identity,
        consentToVaultCopy: false,
      }),
    ).rejects.toThrow(/admin/);
  });

  it("opens a two-of-three document only with two groups", async () => {
    const identities = await Promise.all([
      age.generateX25519Identity(),
      age.generateX25519Identity(),
      age.generateX25519Identity(),
    ]);
    const recipients = await Promise.all(
      identities.map((id) => age.identityToRecipient(id)),
    );
    const file = await encryptSopsDocument({
      format: "yaml",
      plaintext: "hello: world\n",
      recipients: [],
      groups: recipients.map((recipient) => [recipient]),
      threshold: 2,
    });
    const alone = identities[0];
    const first = identities[0];
    const second = identities[1];
    if (!alone || !first || !second) throw new Error("missing identity");
    await expect(
      decryptSopsDocument({
        format: "yaml",
        ciphertext: file,
        identity: alone,
      }),
    ).rejects.toThrow(/groups/i);
    const opened = await decryptSopsDocument({
      format: "yaml",
      ciphertext: file,
      identity: first,
      identities: [first, second],
    });
    expect(opened).toMatch(/hello: world/);
  });
});
