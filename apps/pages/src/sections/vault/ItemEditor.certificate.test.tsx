/** @vitest-environment jsdom */
import type { IssuedCertificate } from "@opensesame/app-core/lib/certs.js";
import { certsSeams } from "@opensesame/app-core/lib/certs.js";
import {
  type CertificateItem,
  type Folder,
  type VaultItem,
  createItem,
} from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { expectInTray } from "../../components/tray.test-support.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { ItemEditor } from "./ItemEditor.js";

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

const originalVaultHooksSeams = { ...vaultHooksSeams };
const originalCertsSeams = { ...certsSeams };
Object.assign(vaultHooksSeams, {
  useVault: () => vault.current,
  useVaultStore: () => ({ saveItem }),
  useCopySecret: () => vi.fn().mockResolvedValue("copied"),
});
Object.assign(certsSeams, {
  issueCertificate: issueCertificateFromHost,
  acknowledgeCertificateDelivery,
});
afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
  Object.assign(certsSeams, originalCertsSeams);
});

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

function savedItem(): VaultItem {
  const item = saveItem.mock.calls[0]?.[0];
  if (!item) throw new Error("missing saved vault item");
  return item;
}

describe("ItemEditor certificates", () => {
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
});
