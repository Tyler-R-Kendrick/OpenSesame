import { describe, expect, it } from "vitest";
import type { CardItem, TypedItem } from "./vault/model.js";
import {
  isPaymentInstrument,
  listPaymentInstruments,
  paymentInstrumentDetail,
} from "./wallet-instruments.js";

const stamp = {
  folderId: null,
  favorite: false,
  notes: "",
  fields: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

describe("wallet instruments", () => {
  it("lists live cards and bank accounts only", () => {
    const card: CardItem = {
      ...stamp,
      id: "c1",
      kind: "card",
      name: "Visa",
      cardholder: "Ada",
      brand: "Visa",
      number: "4242",
      expMonth: "01",
      expYear: "30",
      code: "",
    };
    const bank: TypedItem = {
      ...stamp,
      id: "b1",
      kind: "typed",
      typeId: "bank-account",
      name: "Checking",
      values: { bank: "First National" },
    };
    const login = {
      ...stamp,
      id: "l1",
      kind: "login" as const,
      name: "Mail",
      username: "a",
      password: "b",
      totp: "",
      uris: [],
      passwordChangedAt: stamp.createdAt,
    };
    expect(isPaymentInstrument(login)).toBe(false);
    expect(
      listPaymentInstruments([card, bank, login]).map((item) => item.id),
    ).toEqual(["c1", "b1"]);
    expect(paymentInstrumentDetail(card)).toBe("Visa · •••• 4242");
    expect(paymentInstrumentDetail(bank)).toBe("First National");
  });
});
