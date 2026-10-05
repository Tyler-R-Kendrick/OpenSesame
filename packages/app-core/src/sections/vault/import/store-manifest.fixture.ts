import {
  type CustomField,
  type Folder,
  type VaultItem,
  createItem,
  createTypedItem,
  manualPassword,
  newGrant,
  newUri,
} from "@opensesame/vault-core";
/**
 * Test support: a vault holding one item of every kind the vault supports —
 * the seven built-in kinds with every named property set away from its
 * default, and one typed item per built-in item-type definition with every
 * declared field filled — so a round trip through the store path manifest
 * has nowhere to hide a dropped value. Every value is synthetic.
 */
import {
  FIELD_TYPES,
  type FieldDefinition,
  type FieldValue,
  type FieldValues,
  LEGACY_TYPE_IDS,
  builtinDefinitions,
  definitionFields,
} from "@opensesame/vault-item-types";

const AT = "2026-03-04T05:06:07.000Z";
const PEM_KEY =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFixtureOnlyNotARealKey000000000000\n-----END PRIVATE KEY-----";
const PEM_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIBfixtureCertificateBody\n-----END CERTIFICATE-----";
const PEM_CA =
  "-----BEGIN CERTIFICATE-----\nMIIBfixtureCa\n-----END CERTIFICATE-----";

export const FIXTURE_FOLDERS: Folder[] = [
  { id: "fld_work", name: "Work", createdAt: AT },
  { id: "fld_nested", name: "Personal/Money", createdAt: AT },
];

function extras(label: string): CustomField[] {
  return [
    { id: `${label}-f1`, name: "PIN", value: `${label}-4321`, hidden: true },
    {
      id: `${label}-f2`,
      name: "Branch",
      value: `${label} west`,
      hidden: false,
    },
  ];
}

function login(): VaultItem {
  const item = createItem("account", "GitHub");
  item.folderId = "fld_work";
  item.favorite = true;
  item.username = "octo";
  item.methods = [
    manualPassword(`${item.id}:password`, "correct-horse-7", AT), // gitleaks:allow -- fixture
    {
      id: `${item.id}:authenticator`,
      type: "authenticator",
      secret:
        "otpauth://totp/GitHub:octo?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
    },
    {
      id: `${item.id}:api-key`,
      type: "api-key",
      key: "ghp-fixture",
      header: "",
    }, // gitleaks:allow -- fixture
  ];
  item.uris = [newUri("https://github.com"), newUri("*.github.io", "wildcard")];
  item.notes = "Line one\nLine two";
  item.fields = extras("login");
  return item;
}

function passkey(): VaultItem {
  const item = createItem("passkey", "example.com passkey");
  Object.assign(item, {
    rpId: "example.com",
    username: "ada@example.com",
    credentialIdB64: "Y3JlZGVudGlhbC1pZA==",
    publicKeyB64: "cHVibGljLWtleQ==",
    authenticator: "cross-platform",
    privateKeyPkcs8B64: "cHJpdmF0ZS1rZXktcGtjczg=", // gitleaks:allow -- fixture
    cosePublicKeyB64: "Y29zZS1rZXk=",
    signCount: 0,
    userHandleB64: "dXNlci1oYW5kbGU=",
    discoverable: true,
    alg: -7,
    transports: ["usb", "nfc"],
    custody: "vault",
    provenance: "generated",
    importedFrom: "fixture",
    duplicateOfExternal: false,
    reenrollState: "new-enrolled",
    notes: "Hardware-backed",
    fields: extras("passkey"),
  });
  return item;
}

function card(): VaultItem {
  const item = createItem("card", "Travel card");
  item.folderId = "fld_nested";
  Object.assign(item, {
    cardholder: "A. Rowan",
    brand: "Visa",
    number: "4111111111111111",
    expMonth: "09",
    expYear: "2031",
    code: "123",
    notes: "Foreign fees waived",
    fields: extras("card"),
  });
  return item;
}

function secret(): VaultItem {
  const item = createItem("secret", "Deploy hook");
  item.folderId = "fld_work";
  item.value = "whsec_fixture"; // gitleaks:allow -- fixture
  item.connectionRef = "conn_deploy_hook";
  item.ceiling = [newGrant("invoke", "deploy/*"), newGrant("read", "logs")];
  item.grantees = ["agent:ci", "agent:release"];
  item.notes = "Rotates monthly";
  item.fields = extras("secret");
  return item;
}

function note(): VaultItem {
  const item = createItem("note", "Recovery kit");
  item.notes = "Paper kit in the fire safe.\nSecond copy at the bank.";
  item.fields = extras("note");
  return item;
}

function certificate(): VaultItem {
  const item = createItem("certificate", "dev.local");
  Object.assign(item, {
    commonName: "dev.local",
    dnsNames: "dev.local,api.dev.local",
    ipAddrs: "",
    ttlHours: "72",
    certificatePem: PEM_CERT,
    privateKeyPem: PEM_KEY,
    caPem: PEM_CA,
    serial: "0a:1b:2c",
    notAfter: "2026-12-31T00:00:00Z",
    notes: "Local HTTPS",
    fields: extras("certificate"),
  });
  return item;
}

function drop(): VaultItem {
  const item = createItem("drop", "Shared wifi");
  Object.assign(item, {
    state: "pending",
    claimId: "claim_fixture",
    bearerToken: "bearer_fixture", // gitleaks:allow -- fixture
    expiresAt: "2026-10-01T00:00:00Z",
    keptCopy: { kind: "text", text: "the wifi password" },
  });
  return item;
}

function sampleValue(field: FieldDefinition): FieldValue {
  const spec = FIELD_TYPES[field.type];
  if (spec.valueKind === "record") {
    return Object.fromEntries(
      spec.parts.map((part) => [part.id, `${field.id} ${part.id}`]),
    );
  }
  if (field.type === "totp") {
    return "otpauth://totp/Fixture?secret=JBSWY3DPEHPK3PXP";
  }
  const one = spec.multiline ? `${field.id}\nsecond line` : `${field.id} value`;
  return field.multiple === true ? [one, `${field.id} other`] : one;
}

/** One typed item per built-in definition that is not a legacy kind. */
function typedItems(): VaultItem[] {
  return builtinDefinitions()
    .filter((definition) => !LEGACY_TYPE_IDS.includes(definition.metadata.id))
    .map((definition) => {
      const values: FieldValues = Object.fromEntries(
        definitionFields(definition).map((field) => [
          field.id,
          sampleValue(field),
        ]),
      );
      const item = createTypedItem(
        definition,
        values,
        `${definition.spec.title} item`,
      );
      item.notes = `${definition.metadata.id} notes`;
      item.fields = extras(definition.metadata.id);
      return item;
    });
}

export type FixtureVault = { items: VaultItem[]; folders: Folder[] };

/** The vault the round trip starts from. */
export function everyKindVault(): FixtureVault {
  return {
    items: [
      login(),
      passkey(),
      card(),
      secret(),
      note(),
      certificate(),
      drop(),
      ...typedItems(),
    ],
    folders: FIXTURE_FOLDERS,
  };
}
