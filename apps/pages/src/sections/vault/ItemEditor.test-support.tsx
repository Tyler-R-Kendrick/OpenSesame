/** Shared fixture builders and rendered editor access for ItemEditor tests. */
import type { IssuedCertificate } from "@opensesame/app-core/lib/certs.js";
import {
  type CertificateItem,
  type PasswordMethod,
  type VaultItem,
  createItem,
  passwordMethod,
} from "@opensesame/vault-core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ItemEditor } from "./ItemEditor.js";

export function renderEditor(path = "/vault/new/account") {
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

export function makeCertificate(
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

export function inputByLabel(label: string | RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`expected input for ${String(label)}`);
  }
  return element;
}

export function passwordOf(item: VaultItem): PasswordMethod {
  if (item.kind !== "account") throw new Error("expected a saved account");
  const method = passwordMethod(item);
  if (!method) throw new Error("expected a password method");
  return method;
}

export const issuedCertificate: IssuedCertificate = {
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
