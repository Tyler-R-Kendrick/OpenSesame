import { isString } from "@opensesame/os-domain";
import { type VaultItem, itemTypeId } from "@opensesame/vault-core";

const INSTRUMENT_TYPES = new Set(["card", "bank-account"]);

export function isPaymentInstrument(item: VaultItem): boolean {
  return item.deletedAt === null && INSTRUMENT_TYPES.has(itemTypeId(item));
}

export function listPaymentInstruments(
  items: readonly VaultItem[],
): readonly VaultItem[] {
  return items.filter(isPaymentInstrument);
}

export function paymentInstrumentKindLabel(item: VaultItem): string {
  return itemTypeId(item) === "bank-account" ? "Account" : "Card";
}

export function paymentInstrumentDetail(item: VaultItem): string {
  if (item.kind === "card") {
    const digits = item.number.replaceAll(" ", "");
    const last = digits.length >= 4 ? digits.slice(-4) : "";
    const brand = item.brand.trim();
    if (brand && last) return `${brand} · •••• ${last}`;
    if (brand) return brand;
    if (last) return `•••• ${last}`;
    return item.cardholder.trim() || "Card";
  }
  if (item.kind === "typed" && item.typeId === "bank-account") {
    const bank = item.values.bank;
    return isString(bank) && bank.trim() !== "" ? bank : "Account";
  }
  return paymentInstrumentKindLabel(item);
}
