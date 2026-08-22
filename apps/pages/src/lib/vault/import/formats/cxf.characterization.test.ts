import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";

import { buildCxfExport, serializeCxfExport } from "../../export/cxf.js";
import type { VaultBody } from "../../model.js";
import type { ParseResult } from "../types.js";
import { fidoCxf } from "./cxf.js";

/**
 * Characterization snapshots for the Credential Exchange Format, in both
 * directions.
 *
 * The unit tests beside this file pin the individual rules. These pin the two
 * artefacts a user or another manager actually sees: the exact JSON this vault
 * writes, and the exact `ParseResult` it produces from a document written
 * elsewhere.
 *
 * Both drift silently. A `fieldType` that quietly stops saying
 * `concealed-string` tells the receiving manager a password is safe to display;
 * a passkey field that quietly changes name is a credential that silently stops
 * transferring; and an extension key that quietly moves takes this vault's own
 * round trip with it. None of that fails a type check.
 *
 * A CXF document is plaintext by design, so the fixtures below use obviously
 * fake values — a snapshot file is committed, and a real one never should be.
 *
 * If one of these fails, read the diff before updating it.
 */

const NOW = "2026-03-04T05:06:07.000Z";

function item(kind: string, id: string, name: string) {
  return {
    id,
    kind,
    name,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function vault(): VaultBody {
  return {
    v: 1,
    items: [
      {
        ...item("login", "login-1", "Example Mail"),
        kind: "login",
        folderId: "folder-work",
        favorite: true,
        notes: "Shared with the team.",
        fields: [
          { id: "f1", name: "Seat number", value: "12", hidden: false },
          { id: "f2", name: "Support PIN", value: "0000", hidden: true },
        ],
        username: "fixture@example.com",
        password: "fixture-password",
        totp: "otpauth://totp/Example:fixture?secret=JBSWY3DPEHPK3PXP&issuer=Example",
        uris: [{ id: "u1", uri: "https://mail.example.com", match: "domain" }],
        passwordChangedAt: NOW,
      },
      {
        ...item("passkey", "passkey-1", "example.org passkey"),
        kind: "passkey",
        folderId: "folder-work",
        rpId: "example.org",
        username: "fixture@example.org",
        credentialIdB64: "Y3JlZC1pZC0wMDE=",
        publicKeyB64: "cHVibGljLWtleS1ieXRlcw==",
        authenticator: "cross-platform",
        unlocksVault: false,
      },
      {
        ...item("card", "card-1", "Fixture Card"),
        kind: "card",
        cardholder: "Fixture Holder",
        brand: "Visa",
        number: "4111111111111111",
        expMonth: "07",
        expYear: "2031",
        code: "123",
      },
      {
        ...item("secret", "secret-1", "Deploy Token"),
        kind: "secret",
        value: "fixture-deploy-token",
        ceiling: [],
        grantees: [],
        connectionRef: "conn:github:deploy",
      },
      {
        ...item("note", "note-1", "Safe combination"),
        kind: "note",
        notes: "Left 12, right 4.",
      },
      {
        ...item("certificate", "cert-1", "Local dev cert"),
        kind: "certificate",
        commonName: "localhost",
        dnsNames: "localhost",
        ipAddrs: "127.0.0.1",
        ttlHours: "24",
        certificatePem: "-----BEGIN CERTIFICATE-----",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----",
        caPem: "",
        serial: "01",
        notAfter: NOW,
      },
    ],
    folders: [{ id: "folder-work", name: "Work", createdAt: NOW }],
  };
}

describe("the CXF document this vault writes", () => {
  it("serializes an unlocked vault to exactly this JSON", () => {
    const { document, skipped } = buildCxfExport(vault(), {
      humanConfirmed: true,
      exportedAt: new Date(NOW),
      username: "fixture",
      email: "fixture@example.com",
    });
    expect(serializeCxfExport(document)).toMatchSnapshot();
    expect(skipped).toMatchSnapshot();
  });
});

/** A document as another manager would write it, exercising every type. */
const FOREIGN = {
  version: 1,
  exporter: "AnotherManager",
  timestamp: 1_772_600_767,
  accounts: [
    {
      id: "acct-1",
      username: "fixture",
      email: "fixture@example.com",
      collections: [
        {
          id: "col-1",
          creationAt: 1_767_324_245,
          modifiedAt: 1_767_324_245,
          title: "Everyday",
          items: [{ item: "cxf-login" }, { item: "cxf-passkey" }],
          subcollections: [
            {
              id: "col-2",
              title: "Banking",
              items: ["cxf-card"],
            },
          ],
        },
      ],
      items: [
        {
          id: "cxf-login",
          creationAt: 1_767_324_245,
          modifiedAt: 1_770_090_306,
          title: "Fixture Mail",
          favorite: true,
          tags: ["personal", "email"],
          scope: {
            urls: ["https://mail.example.com", "https://webmail.example.com"],
            androidApps: [],
          },
          credentials: [
            {
              type: "BasicAuth",
              username: { fieldType: "email", value: "fixture@example.com" },
              password: {
                fieldType: "concealed-string",
                value: "fixture-password",
              },
            },
            {
              type: "TOTP",
              secret: "JBSWY3DPEHPK3PXP",
              period: 60,
              digits: 8,
              algorithm: "sha256",
              username: "fixture",
              issuer: "Example",
            },
            {
              type: "Note",
              content: { fieldType: "string", value: "A note on the login." },
            },
            {
              type: "CustomFields",
              id: "cf-1",
              label: "Extra",
              fields: [
                { fieldType: "string", label: "Seat", value: "12" },
                {
                  fieldType: "concealed-string",
                  label: "Support PIN",
                  value: "0000",
                },
                { fieldType: "string", value: "no label at all" },
              ],
            },
          ],
        },
        {
          id: "cxf-passkey",
          creationAt: 1_767_324_245,
          modifiedAt: 1_767_324_245,
          title: "example.org",
          credentials: [
            {
              type: "Passkey",
              credentialId: "Y3JlZC1pZC0wMDE",
              rpId: "example.org",
              username: "fixture@example.org",
              userDisplayName: "Fixture Person",
              userHandle: "dXNlci1oYW5kbGU",
              key: "cHJpdmF0ZS1rZXktdGhpcy12YXVsdC1yZWZ1c2Vz",
            },
          ],
        },
        {
          id: "cxf-card",
          creationAt: 1_767_324_245,
          modifiedAt: 1_767_324_245,
          title: "Fixture Card",
          credentials: [
            {
              type: "CreditCard",
              number: {
                fieldType: "concealed-string",
                value: "4111111111111111",
              },
              fullName: { fieldType: "string", value: "Fixture Holder" },
              cardType: { fieldType: "string", value: "Visa" },
              verificationNumber: {
                fieldType: "concealed-string",
                value: "123",
              },
              expiryDate: { fieldType: "year-month", value: "2031-7" },
            },
          ],
        },
        {
          id: "cxf-ssh",
          creationAt: 1_767_324_245,
          modifiedAt: 1_767_324_245,
          title: "Build box",
          credentials: [
            {
              type: "SSHKey",
              keyType: "ed25519",
              privateKey: {
                fieldType: "concealed-string",
                value: "-----BEGIN OPENSSH PRIVATE KEY-----fixture",
              },
              keyComment: "fixture@laptop",
            },
          ],
        },
        {
          id: "cxf-api",
          creationAt: 1_767_324_245,
          modifiedAt: 1_767_324_245,
          title: "Weather service",
          credentials: [
            {
              type: "APIKey",
              key: { fieldType: "concealed-string", value: "fixture-api-key" },
              username: "fixture",
            },
          ],
        },
        {
          id: "cxf-note",
          creationAt: 1_767_324_245,
          modifiedAt: 1_767_324_245,
          title: "Safe combination",
          credentials: [
            { type: "Note", content: { fieldType: "string", value: "L12 R4" } },
          ],
        },
        {
          id: "cxf-wifi",
          creationAt: 1_767_324_245,
          modifiedAt: 1_767_324_245,
          title: "Home Wi-Fi",
          credentials: [
            {
              type: "WifiCredential",
              ssid: "Fixture Net",
              passphrase: {
                fieldType: "concealed-string",
                value: "fixture-wifi",
              },
            },
          ],
        },
        {
          id: "cxf-address",
          creationAt: 1_767_324_245,
          modifiedAt: 1_767_324_245,
          title: "Home address",
          credentials: [
            { type: "Address", streetAddress: "1 Example Way" },
            { type: "PersonName", given: "Fixture" },
          ],
        },
      ],
    },
  ],
};

describe("what another manager's CXF document becomes", () => {
  it("maps every credential type to exactly this result", () => {
    const result: ParseResult = fidoCxf.parse({
      fileName: "another-manager.json",
      text: JSON.stringify(FOREIGN),
      headers: null,
      json: overlapCast(FOREIGN),
      bytes: null,
    });
    expect(result).toMatchSnapshot();
  });
});
