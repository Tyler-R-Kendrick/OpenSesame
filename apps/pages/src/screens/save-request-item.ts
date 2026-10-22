import {
  type SaveRequest,
  type SaveRequestType,
  saveRequestField,
} from "@opensesame/app-core/lib/save-request.js";
import type { VaultItem } from "@opensesame/vault-core";
import {
  createItem,
  createTypedItem,
  detectCardBrand,
  newId,
} from "@opensesame/vault-core";
import { loadPack, loadedPackText } from "@opensesame/vault-item-types";

type InstallHost = {
  installItemTypeDefinition: (text: string) => Promise<{ ok: boolean }>;
};

function expiry(value: string | undefined): {
  month: string;
  year: string;
} | null {
  if (!value) return null;
  const match = /^(\d{4})[-/](\d{1,2})$|^(\d{1,2})[-/](\d{2,4})$/u.exec(
    value.trim(),
  );
  if (!match) return null;
  const year = match[1] ?? match[4] ?? "";
  const month = match[2] ?? match[3] ?? "";
  if (!year || !month) return null;
  const fullYear = year.length === 2 ? `20${year}` : year;
  return { month: month.padStart(2, "0"), year: fullYear };
}

function addressNotes(request: SaveRequest): string {
  const labels = new Map([
    ["street-address", "Address"],
    ["address-level1", "State"],
    ["address-level2", "City"],
    ["postal-code", "Postal code"],
    ["country", "Country"],
  ]);
  const lines: string[] = [];
  for (const field of request.fields) {
    const label = labels.get(field.autocomplete);
    if (label) lines.push(`${label}: ${field.value}`);
  }
  return lines.join("\n");
}

function loginItem(request: SaveRequest, sourceOrigin: string): VaultItem {
  const item = createItem("account", request.title);
  item.username = saveRequestField(request, "username") ?? "";
  item.notes = request.notes ?? "";
  // A page may not invent another site's login URL. The item belongs to the
  // origin that presented the button; the person can edit it after review.
  item.uris = [{ id: newId(), uri: sourceOrigin, match: "domain" }];
  const password =
    saveRequestField(request, "current-password") ??
    saveRequestField(request, "password");
  const first = item.methods[0];
  if (password && first?.type === "password") {
    item.methods[0] = {
      ...first,
      secret: password,
      changedAt: new Date().toISOString(),
    };
  }
  const otp = saveRequestField(request, "one-time-code");
  if (otp) {
    item.methods.push({ id: newId(), type: "authenticator", secret: otp });
  }
  return item;
}

function cardItem(request: SaveRequest): VaultItem {
  const item = createItem("card", request.title);
  const number = (saveRequestField(request, "cc-number") ?? "").replaceAll(
    /[ -]/gu,
    "",
  );
  item.number = number;
  item.brand = detectCardBrand(number)?.name ?? "";
  item.cardholder = saveRequestField(request, "cc-name") ?? "";
  item.code = saveRequestField(request, "cc-csc") ?? "";
  const exp = expiry(saveRequestField(request, "cc-exp"));
  if (exp) {
    item.expMonth = exp.month;
    item.expYear = exp.year;
  }
  const address = addressNotes(request);
  item.notes = [request.notes, address].filter(Boolean).join("\n\n");
  return item;
}

async function cryptoItem(
  request: SaveRequest,
  host: InstallHost,
): Promise<VaultItem | null> {
  const definition = await loadPack("crypto-wallet");
  const text = loadedPackText("crypto-wallet");
  if (!text) return null;
  const installed = await host.installItemTypeDefinition(text);
  if (!installed.ok) return null;
  return createTypedItem(
    definition,
    {
      walletName: request.title,
      network: "",
      recoveryPhrase: saveRequestField(request, "crypto-recovery-seed") ?? "",
      privateKey: "",
      pin: "",
      addresses: saveRequestField(request, "crypto-address")
        ? [saveRequestField(request, "crypto-address") ?? ""]
        : [],
      derivationPath: "",
    },
    request.title,
  );
}

export type SaveItemResult = { item: VaultItem } | { error: string };

/** Build the vault item a reviewed save request describes. It does not save. */
export async function buildSaveItem(
  request: SaveRequest,
  type: SaveRequestType,
  sourceOrigin: string,
  host: InstallHost,
): Promise<SaveItemResult> {
  if (type === "login") {
    return { item: loginItem(request, sourceOrigin) };
  }
  if (type === "credit-card") {
    return { item: cardItem(request) };
  }
  try {
    const item = await cryptoItem(request, host);
    return item
      ? { item }
      : { error: "This build cannot install the crypto-wallet item type." };
  } catch {
    return { error: "This build cannot install the crypto-wallet item type." };
  }
}
