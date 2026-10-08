import type { IssuedCertificate } from "@opensesame/app-core/lib/certs.js";
import { registerLegacyItemKinds } from "@opensesame/app-core/lib/contributions.test-support.js";
import { folderKey } from "@opensesame/app-core/lib/vault/path-suggest.js";
import {
  type AccountItem,
  type CertificateItem,
  type Folder,
  type PasswordMethod,
  type VaultItem,
  createItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { MemoryRouter, Route, Routes } from "react-router";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { choose, shown } from "./path-field.test-support.js";

type VaultFixture = { current: { items: VaultItem[]; folders: Folder[] } };

const vault = vi.hoisted(
  (): VaultFixture => ({ current: { items: [], folders: [] } }),
);
const saveItem = vi.hoisted(() => vi.fn<(item: VaultItem) => Promise<void>>());
const issueCertificateFromHost = vi.hoisted(() =>
  vi.fn<
    (input: {
      commonName: string;
      dnsNames?: string[];
      ipAddrs?: string[];
      ttlHours?: number;
      idempotencyKey?: string;
    }) => Promise<IssuedCertificate>
  >(),
);
const acknowledgeCertificateDelivery = vi.hoisted(() =>
  vi.fn<(deliveryId: string) => Promise<void>>(),
);

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ saveItem }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});
afterAll(() => Object.assign(vaultHooksSeams, originalVaultHooksSeams));

import { certsSeams } from "@opensesame/app-core/lib/certs.js";
Object.assign(certsSeams, {
  issueCertificate: issueCertificateFromHost,
  acknowledgeCertificateDelivery,
});

import { expectInTray } from "../../components/tray.test-support.js";
import { ItemEditor } from "./ItemEditor.js";
import {
  type AccountSeed,
  makeAccount as makeAccountBase,
} from "./account.test-support.js";

/** The editor at `path`, new or edit, with a catch-all for where saving goes. */
function renderEditor(path = "/vault/new/account") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vault/new/:kind?" element={<ItemEditor mode="new" />} />
        <Route
          path="/vault/:itemId/edit"
          element={<ItemEditor mode="edit" />}
        />
        <Route path="*" element={<div>navigated away</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function makeAccount(overrides: AccountSeed = {}): AccountItem {
  return makeAccountBase({
    id: "itm_1",
    name: "Webmail",
    password: "old-password",
    passwordChangedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  });
}

function makeCertificate(
  overrides: Partial<CertificateItem> = {},
): CertificateItem {
  return {
    ...createItem("certificate", "Local TLS"),
    id: "itm_cert",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    commonName: "localhost",
    ...overrides,
  };
}

const issuedCertificate: IssuedCertificate = {
  certificate: "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----",
  privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  caCertificate: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
  serial: "aabbcc",
  commonName: "barber.local",
  dnsNames: ["barber.local", "www.barber.local"],
  notBefore: "2026-08-21T00:00:00Z",
  notAfter: "2026-08-22T00:00:00Z",
  deliveryId: "certificate-request:one",
};

function inputByLabel(label: string | RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`expected input for ${String(label)}`);
  }
  return element;
}

function passwordOf(item: VaultItem): PasswordMethod {
  if (item.kind !== "account") throw new Error("expected a saved account");
  const method = passwordMethod(item);
  if (!method) throw new Error("expected a password method");
  return method;
}

function savedItem(): VaultItem {
  const item = saveItem.mock.calls[0]?.[0];
  if (!item) throw new Error("missing saved vault item");
  return item;
}

describe("ItemEditor", () => {
  beforeEach(() => {
    vault.current = { items: [], folders: [] };
    saveItem.mockResolvedValue(undefined);
    issueCertificateFromHost.mockResolvedValue(issuedCertificate);
    acknowledgeCertificateDelivery.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("requires a name before saving", async () => {
    renderEditor();
    await userEvent.clear(screen.getByLabelText(/^Name$/i));
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await expectInTray("Give this item a name");
    expect(saveItem).not.toHaveBeenCalled();
  });

  it("creates a new account and navigates to its detail", async () => {
    renderEditor();
    expect(screen.queryByLabelText(/^Type$/i)).toBeNull();
    expect(screen.getByText(".account")).toBeTruthy();
    await userEvent.clear(screen.getByLabelText(/^Name$/i));
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Webmail");
    await userEvent.clear(screen.getByLabelText(/^Username \/ ID$/i));
    await userEvent.type(
      screen.getByLabelText(/^Username \/ ID$/i),
      "me@example.com",
    );
    await userEvent.clear(screen.getByLabelText(/^Password$/i));
    await userEvent.type(screen.getByLabelText(/^Password$/i), "s3cret-s3cret");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = savedItem();
    if (saved.kind !== "account") throw new Error("expected saved account");
    expect(saved.name).toBe("Webmail");
    expect(saved.username).toBe("me@example.com");
    // Typing a password is choosing to type it: the generator is Manual.
    expect(passwordOf(saved)).toMatchObject({
      secret: "s3cret-s3cret",
      generator: { id: "manual" },
      pepper: true,
    });
    expect(await screen.findByText("navigated away")).toBeTruthy();
  });

  it("behavior: issues and seals a new certificate in one submit", async () => {
    renderEditor("/vault/new/certificate");
    await userEvent.clear(screen.getByLabelText(/^Name$/i));
    await userEvent.clear(screen.getByLabelText(/Common name/i));
    await userEvent.type(screen.getByLabelText(/Common name/i), "barber.local");
    await userEvent.click(
      screen.getByRole("button", { name: "Add DNS names" }),
    );
    await userEvent.type(
      screen.getByLabelText(/DNS names/i),
      "barber.local, www.barber.local",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Create certificate/i }),
    );

    await waitFor(() => expect(saveItem).toHaveBeenCalledOnce());
    expect(await screen.findByText("navigated away")).toBeTruthy();
    expect(acknowledgeCertificateDelivery).toHaveBeenCalledWith(
      "certificate-request:one",
    );
    expect(saveItem.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledgeCertificateDelivery.mock.invocationCallOrder[0] ?? 0,
    );
    expect(issueCertificateFromHost).toHaveBeenCalledWith({
      commonName: "barber.local",
      dnsNames: ["barber.local", "www.barber.local"],
      ipAddrs: [],
      ttlHours: 24,
      idempotencyKey: expect.any(String),
    });
    expect(savedItem()).toMatchObject({
      kind: "certificate",
      name: "barber.local",
      commonName: "barber.local",
      certificatePem: issuedCertificate.certificate,
      privateKeyPem: issuedCertificate.privateKey,
      caPem: issuedCertificate.caCertificate,
    });
  });

  it("characterization: asks for names and lifetime, never PEM material", () => {
    const { container } = renderEditor("/vault/new/certificate");
    expect(screen.queryByLabelText(/^Certificate$/i)).toBeNull();
    expect(screen.queryByLabelText(/^Private key$/i)).toBeNull();
    expect(screen.queryByLabelText(/^Issuing CA$/i)).toBeNull();
    expect({
      labels: Array.from(container.querySelectorAll("label"), (label) =>
        label.textContent?.trim(),
      ),
      actions: Array.from(
        container.querySelectorAll("button"),
        (button) =>
          button.getAttribute("aria-label") ?? button.textContent?.trim(),
      ),
      guidance: Array.from(container.querySelectorAll("p.hint"), (hint) =>
        hint.textContent?.trim(),
      ),
    }).toEqual({
      // A core-only installation: model suggestions are the on-device
      // model's (`item-contributions.test.tsx` draws them when it is on).
      actions: [
        "Pin item",
        "Add DNS names",
        "Add IP addresses",
        "Add notes",
        "Add custom field",
        "Create certificate",
      ],
      guidance: [],
      labels: ["Common name", "TTL (hours)"],
    });
  });

  it("adversarial: does not save when Host issuance fails", async () => {
    issueCertificateFromHost.mockRejectedValueOnce(new Error("issuer offline"));
    renderEditor("/vault/new/certificate");
    await userEvent.type(screen.getByLabelText(/Common name/i), "barber.local");
    await userEvent.click(
      screen.getByRole("button", { name: /Create certificate/i }),
    );

    await expectInTray("issuer offline");
    expect(saveItem).not.toHaveBeenCalled();
  });

  it("retries vault sealing without issuing another certificate", async () => {
    saveItem
      .mockRejectedValueOnce(new Error("vault temporarily locked"))
      .mockResolvedValueOnce(undefined);
    renderEditor("/vault/new/certificate");
    await userEvent.type(screen.getByLabelText(/Common name/i), "barber.local");
    await userEvent.click(
      screen.getByRole("button", { name: /Create certificate/i }),
    );
    await expectInTray("vault temporarily locked");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalledTimes(2));
    await screen.findByText("navigated away");
    expect(acknowledgeCertificateDelivery).toHaveBeenCalledOnce();
    expect(issueCertificateFromHost).toHaveBeenCalledOnce();
    expect(saveItem.mock.calls[1]?.[0]).toEqual(saveItem.mock.calls[0]?.[0]);
  });

  it("issues a blank legacy certificate instead of saving it blank", async () => {
    vault.current = { items: [makeCertificate()], folders: [] };
    renderEditor("/vault/itm_cert/edit");
    await userEvent.click(screen.getByRole("button", { name: /Issue now/i }));

    await waitFor(() => expect(saveItem).toHaveBeenCalledOnce());
    expect(savedItem()).toMatchObject({
      certificatePem: issuedCertificate.certificate,
      privateKeyPem: issuedCertificate.privateKey,
      caPem: issuedCertificate.caCertificate,
    });
  });

  it("edits issued metadata without reissuing or exposing PEM inputs", async () => {
    vault.current = {
      items: [
        makeCertificate({
          certificatePem: issuedCertificate.certificate,
          privateKeyPem: issuedCertificate.privateKey,
          caPem: issuedCertificate.caCertificate,
          serial: issuedCertificate.serial,
          notAfter: issuedCertificate.notAfter,
        }),
      ],
      folders: [],
    };
    renderEditor("/vault/itm_cert/edit");
    expect(inputByLabel(/Common name/i).readOnly).toBe(true);
    expect(screen.queryByLabelText(/^Private key$/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));

    await waitFor(() => expect(saveItem).toHaveBeenCalledOnce());
    expect(issueCertificateFromHost).not.toHaveBeenCalled();
  });

  it("prefills a new account from the save-prompt query", () => {
    renderEditor("/vault/new/account?name=Mail&uri=https://mail.example.com");
    expect(inputByLabel(/^Name$/i).value).toBe("Mail");
    expect(screen.getByDisplayValue("https://mail.example.com")).toBeTruthy();
  });

  it("does not offer a connection reference on a secret", () => {
    renderEditor("/vault/new/secret?name=Token&ref=conn/github/pat");
    expect(screen.queryByLabelText(/Connection reference/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add connection reference" }),
    ).toBeNull();
  });

  it("offers a connection reference on a server", () => {
    renderEditor("/vault/new/server");
    expect(screen.getByLabelText(/Connection reference/i)).toBeTruthy();
  });

  it("prefills a new passkey relying party from the query", () => {
    renderEditor("/vault/new/passkey?uri=example.com");
    expect(inputByLabel(/Relying party/i).value).toBe("example.com");
  });

  it("switches item kind and keeps the name", async () => {
    const revoke = registerLegacyItemKinds();
    try {
      renderEditor("/vault/new");
      await userEvent.clear(screen.getByLabelText(/^Name$/i));
      await userEvent.type(screen.getByLabelText(/^Name$/i), "My card");
      await choose("Type", "card");
      expect(screen.getByLabelText(/Cardholder/i)).toBeTruthy();
      expect(inputByLabel(/^Name$/i).value).toBe("My card");
      expect(shown("Type")).toBe(".card");
    } finally {
      revoke();
    }
  });
  it("strips non-digits from card numbers", async () => {
    renderEditor("/vault/new/card");
    await userEvent.type(
      screen.getByLabelText(/^Number$/i),
      "4111-1111 x 4242",
    );
    expect(inputByLabel(/^Number$/i).value).toBe("411111114242");
  });
  it("adds, edits, and removes website addresses", async () => {
    renderEditor("/vault/new/account?uri=https://old.example.com");
    await userEvent.click(screen.getByRole("button", { name: /Add address/i }));
    const address = screen.getByLabelText("Address 2");
    await userEvent.type(address, "https://mail.example.com");
    await userEvent.selectOptions(
      screen.getByLabelText("Match rule 2"),
      "exact",
    );
    await userEvent.click(screen.getByLabelText("Remove address 1"));
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Mail");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(savedItem()).toMatchObject({
      kind: "account",
      uris: [{ uri: "https://mail.example.com", match: "exact" }],
    });
  });
  it("starts with an empty address and saves its removal", async () => {
    renderEditor();
    expect(inputByLabel("Address 1").value).toBe("");
    await userEvent.click(screen.getByLabelText("Remove address 1"));
    expect(screen.queryByLabelText("Address 1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(savedItem()).toMatchObject({ kind: "account", uris: [] });
  });
  it("reveals the password field and generates another", async () => {
    renderEditor();
    const password = inputByLabel(/^Password$/i);
    expect(password.type).toBe("password");
    await userEvent.click(
      screen.getByRole("button", { name: /Show password/i }),
    );
    expect(password.type).toBe("text");
    await userEvent.click(
      screen.getByRole("button", { name: /Hide password/i }),
    );
    expect(password.type).toBe("password");
    const before = password.value;
    await userEvent.click(
      screen.getByRole("button", { name: /Generate another password/i }),
    );
    expect(password.value.length).toBeGreaterThan(0);
    expect(password.value).not.toBe(before);
    expect(password.type).toBe("text");
  });

  it("says there is nothing to edit for a missing item", () => {
    render(
      <MemoryRouter initialEntries={["/vault/itm_gone/edit"]}>
        <Routes>
          <Route
            path="/vault/:itemId/edit"
            element={<ItemEditor mode="edit" />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Nothing to edit")).toBeTruthy();
  });

  it("edits an existing account and bumps changedAt on password change", async () => {
    vault.current = { items: [makeAccount()], folders: [] };
    renderEditor("/vault/itm_1/edit");
    expect(screen.queryByLabelText(/^Type$/i)).toBeNull();
    const password = screen.getByLabelText(/^Password$/i);
    await userEvent.clear(password);
    await userEvent.type(password, "brand-new-password");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const method = passwordOf(savedItem());
    expect(method.secret).toBe("brand-new-password");
    expect(method.changedAt).not.toBe("2026-08-01T00:00:00Z");
  });

  it("keeps changedAt when the password is untouched", async () => {
    vault.current = { items: [makeAccount()], folders: [] };
    renderEditor("/vault/itm_1/edit");
    const username = screen.getByLabelText(/^Username \/ ID$/i);
    await userEvent.clear(username);
    await userEvent.type(username, "other@example.com");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(passwordOf(savedItem()).changedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("saves a secret value and leaves the connection reference empty", async () => {
    const sent = vi.spyOn(globalThis, "fetch");
    renderEditor("/vault/new/secret?ref=conn/github/pat");
    await userEvent.clear(screen.getByLabelText(/^Name$/i));
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Deploy hook");
    await userEvent.clear(screen.getByLabelText(/Secret value/i));
    await userEvent.type(screen.getByLabelText(/Secret value/i), "whsec_1");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    expect(await screen.findByText("navigated away")).toBeTruthy();
    const saved = savedItem();
    if (saved.kind !== "secret") throw new Error("expected saved secret");
    expect(saved.name).toBe("Deploy hook");
    expect(saved.value).toBe("whsec_1");
    expect(saved.connectionRef).toBe("");
    expect(sent).not.toHaveBeenCalled();
    sent.mockRestore();
  });

  it("keeps grantee editing out of secret ceremonies and preserves grants", async () => {
    renderEditor("/vault/new/secret");
    expect(screen.queryByLabelText(/Grantees/i)).toBeNull();
    cleanup();
    const secret = createItem("secret");
    secret.grantees = ["agt_one", "agt_two"];
    vault.current.items = [secret];
    renderEditor(`/vault/${secret.id}/edit`);
    expect(screen.queryByLabelText(/Grantees/i)).toBeNull();
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Token");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(savedItem()).toHaveProperty("grantees", secret.grantees);
  });

  it("keeps the capability ceiling off the secret form and preserves one", async () => {
    renderEditor("/vault/new/secret");
    expect(screen.queryByText("Capability ceiling")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Add capability/i }),
    ).toBeNull();
    cleanup();
    const secret = createItem("secret");
    secret.ceiling = [
      {
        id: "g1",
        action: "http.post",
        resource: "https://deploy.example.com",
      },
    ];
    vault.current.items = [secret];
    renderEditor(`/vault/${secret.id}/edit`);
    expect(screen.queryByText("Capability ceiling")).toBeNull();
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Token");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = savedItem();
    if (saved.kind !== "secret") throw new Error("expected saved secret");
    expect(saved.ceiling).toEqual(secret.ceiling);
  });

  it("manages custom fields with conceal toggles", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: /Add custom/ }));
    const name = screen.getByLabelText("Field name");
    await userEvent.type(name, "API key");
    const value = inputByLabel("Field value");
    await userEvent.type(value, "ak_123");
    expect(value.type).toBe("text");
    await userEvent.click(
      screen.getByRole("button", { name: /Conceal this field/i }),
    );
    expect(value.type).toBe("password");
    await userEvent.type(screen.getByLabelText(/^Name$/i), "With fields");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    const saved = savedItem();
    expect(saved.fields).toEqual([
      expect.objectContaining({
        name: "API key",
        value: "ak_123",
        hidden: true,
      }),
    ]);
  });

  it("removes custom fields", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: /Add custom/ }));
    await userEvent.type(screen.getByLabelText("Field name"), "API key");
    await userEvent.click(
      screen.getByRole("button", { name: /Remove API key/i }),
    );
    expect(screen.queryByLabelText("Field name")).toBeNull();
  });

  it("assigns a folder and favorite flag", async () => {
    vault.current = {
      items: [],
      folders: [{ id: "fld_1", name: "Work", createdAt: "2026-08-01" }],
    };
    renderEditor();
    await choose("Folder", folderKey("fld_1"));
    await userEvent.click(screen.getByRole("button", { name: "Pin item" }));
    screen.getByRole("button", { name: "Unpin item", pressed: true });
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Filed");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(savedItem()).toMatchObject({ folderId: "fld_1", favorite: true });
  });

  it("edits passkey and note fields", async () => {
    renderEditor("/vault/new/passkey");
    await userEvent.type(
      screen.getByLabelText(/Relying party/i),
      "example.com",
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/^Authenticator$/i),
      "cross-platform",
    );
    await userEvent.type(screen.getByLabelText(/Credential id/i), "Y3JlZA");
    await userEvent.type(screen.getByLabelText(/^Name$/i), "My key");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await waitFor(() => expect(saveItem).toHaveBeenCalled());
    expect(saveItem.mock.calls[0]?.[0]).toMatchObject({
      kind: "passkey",
      rpId: "example.com",
      authenticator: "cross-platform",
      credentialIdB64: "Y3JlZA",
    });
  });

  it("surfaces save failures", async () => {
    saveItem.mockRejectedValue(new Error("vault locked"));
    renderEditor();
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Nope");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await expectInTray("vault locked");
  });

  it("uses a generic message for non-Error save failures", async () => {
    saveItem.mockRejectedValue("boom");
    renderEditor();
    await userEvent.type(screen.getByLabelText(/^Name$/i), "Nope");
    await userEvent.click(screen.getByRole("button", { name: /Save item/i }));
    await expectInTray("Could not save this item");
  });

  it("cancels back to the vault list for new items", () => {
    renderEditor();
    const cancel = screen.getByRole("link", { name: /Cancel/i });
    expect(cancel.getAttribute("href")).toBe("/vault");
  });
});
