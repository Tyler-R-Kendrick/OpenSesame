/**
 * ADR 0139 drift test for the sealed-store bridge (ADR 0037 §6): the file
 * Pages saves is exactly `spec/conformance/store-manifest.json`'s manifest,
 * and that file merges back unchanged. `crates/sealed-store/tests/
 * manifest_conformance.rs` seals the same manifest with `pass seal`'s code
 * and checks every entry it expects.
 *
 * Regenerate after an intended format change:
 *   UPDATE_STORE_MANIFEST=1 pnpm --filter @opensesame/app-core exec \
 *     vitest run src/sections/vault/import/store-manifest.conformance.test.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Folder,
  type VaultItem,
  createItem,
  newUri,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import fixture from "../../../../../../spec/conformance/store-manifest.json" with {
  type: "json",
};
import {
  extractOtpauthFromTrailer,
  parseTrailerMeta,
} from "../../../lib/vault/store-sync.js";
import {
  planStoreManifest,
  readStoreManifest,
  storeManifestFile,
} from "./store-manifest.js";

const FIXTURE = join(
  import.meta.dirname,
  "../../../../../../spec/conformance/store-manifest.json",
);

const DEV: Folder = {
  id: "fld_dev",
  name: "Dev",
  createdAt: "2026-01-01T00:00:00Z",
};
const PERSONAL: Folder = {
  id: "fld_personal",
  name: "Personal",
  createdAt: "2026-01-01T00:00:00Z",
};

const CHANGED = "2026-01-02T03:04:05.000Z";
const KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIConformanceOnly\n-----END PRIVATE KEY-----";
const CERT_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBconformanceOnly\n-----END CERTIFICATE-----";

type Sealed = { name: string; kind: string; otp: boolean };

/**
 * What the sealed store holds for each manifest entry: its name, the kind its
 * trailer names, and whether an otpauth line made it structured OTP.
 */
function sealedOf(manifest: readonly { path: string; trailer: string }[]) {
  return manifest.map(
    ({ path, trailer }): Sealed => ({
      name: path,
      kind: String(parseTrailerMeta(trailer).kind),
      otp: extractOtpauthFromTrailer(trailer) !== null,
    }),
  );
}

/** The vault the fixture was written from. Nothing random reaches the file. */
function fixtureVault() {
  const github = createItem("login", "GitHub");
  github.folderId = DEV.id;
  github.username = "octo";
  github.password = "correct-horse-7"; // gitleaks:allow -- conformance fixture
  github.totp =
    "otpauth://totp/GitHub:octo?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
  github.uris = [
    newUri("https://github.com"),
    newUri("gist.github.com", "host"),
  ];

  github.passwordChangedAt = CHANGED;

  const bank = createItem("login", "Bank");
  bank.username = "avery";
  bank.password = "Fjord-Lantern-9"; // gitleaks:allow -- conformance fixture
  bank.totp = "JBSWY3DPEHPK3PXP";
  bank.notes = "Branch 12";
  bank.passwordChangedAt = CHANGED;

  const hook = createItem("secret", "Deploy hook");
  hook.folderId = DEV.id;
  hook.value = "whsec_conformance"; // gitleaks:allow -- conformance fixture
  hook.connectionRef = "conn_deploy_hook";

  const kit = createItem("note", "Recovery kit");
  kit.folderId = PERSONAL.id;
  kit.notes = "Paper kit in the fire safe.";

  // The kinds the first format could not carry back: a card, a certificate
  // whose PEMs span lines (so line one stays empty), and a vault-held passkey.
  const card = createItem("card", "Travel card");
  card.folderId = PERSONAL.id;
  card.cardholder = "A. Rowan";
  card.brand = "Visa";
  card.number = "4111111111111111"; // gitleaks:allow -- conformance fixture
  card.expMonth = "09";
  card.expYear = "2031";
  card.code = "123";
  card.fields = [{ id: "f_pin", name: "PIN", value: "4321", hidden: true }];

  const cert = createItem("certificate", "dev.local");
  cert.folderId = DEV.id;
  cert.certificatePem = CERT_PEM;
  cert.privateKeyPem = KEY_PEM;
  cert.serial = "0a:1b:2c";
  cert.notAfter = "2026-12-31T00:00:00Z";

  const passkey = createItem("passkey", "example.com");
  passkey.rpId = "example.com";
  passkey.username = "ada@example.com";
  passkey.credentialIdB64 = "Y3JlZGVudGlhbC1pZA==";
  passkey.publicKeyB64 = "cHVibGljLWtleQ==";
  passkey.privateKeyPkcs8B64 = "cHJpdmF0ZS1rZXk="; // gitleaks:allow -- conformance fixture
  passkey.custody = "vault";
  passkey.alg = -7;

  const demo = { ...createItem("login", "Sample login"), sample: true };
  const gone = {
    ...createItem("login", "Trashed"),
    deletedAt: "2026-02-01T00:00:00Z",
  };
  const items: VaultItem[] = [
    github,
    bank,
    hook,
    kit,
    card,
    cert,
    passkey,
    demo,
    gone,
  ];
  return { items, folders: [DEV, PERSONAL] };
}

describe("store path manifest conformance (spec/conformance/store-manifest.json)", () => {
  it("is exactly what Pages saves for the fixture vault", () => {
    const { items, folders } = fixtureVault();
    const file = storeManifestFile(items, folders);
    if (process.env.UPDATE_STORE_MANIFEST === "1") {
      writeFileSync(
        FIXTURE,
        `${JSON.stringify(
          {
            ...fixture,
            manifest: JSON.parse(file.text),
            sealed: sealedOf(JSON.parse(file.text)),
          },
          null,
          2,
        )}\n`,
      );
    }
    expect(JSON.parse(file.text)).toEqual(fixture.manifest);
  });

  it("names each entry the sealed store is expected to hold, with its kind", () => {
    expect(fixture.sealed).toEqual(sealedOf(fixture.manifest));
    expect(new Set(fixture.sealed.map((entry) => entry.kind))).toEqual(
      new Set(["login", "secret", "note", "card", "certificate", "passkey"]),
    );
  });

  it("keeps every line one a single line, so pass seal stores it exactly", () => {
    for (const entry of fixture.manifest) {
      expect(entry.secret).not.toMatch(/[\r\n]/u);
    }
  });

  it("merges back into an empty vault whole, and a second time changes nothing", () => {
    const entries = readStoreManifest(fixture.manifest);
    expect(entries).toHaveLength(fixture.manifest.length);
    if (entries === null) return;

    const first = planStoreManifest(entries, [], []);
    expect(first.adds).toHaveLength(entries.length);
    const items = first.adds;
    const folders = first.newFolders;
    expect(folders.map((folder) => folder.name).sort()).toEqual([
      "Dev",
      "Personal",
    ]);
    expect(items.map((item) => item.kind)).toEqual(
      fixture.sealed.map((entry) => entry.kind),
    );
    // The items it made save the same file again.
    expect(JSON.parse(storeManifestFile(items, folders).text)).toEqual(
      fixture.manifest,
    );

    const second = planStoreManifest(entries, items, folders);
    expect(second).toMatchObject({
      adds: [],
      updates: [],
      newFolders: [],
      unchanged: entries.length,
      kept: 0,
    });
  });
});
