import type { SaveRequest } from "@opensesame/app-core/lib/save-request.js";
import { describe, expect, it } from "vitest";
import { buildSaveItem } from "./save-request-item.js";

const host = {
  installItemTypeDefinition: async () => ({ ok: true }),
};

function request(
  fields: { autocomplete: string; value: string }[],
): SaveRequest {
  return { title: "Example", fields, notes: "from a site" };
}

describe("save request items", () => {
  it("builds an account from a reviewed login", async () => {
    const result = await buildSaveItem(
      request([
        { autocomplete: "username", value: "ada@example.test" },
        { autocomplete: "current-password", value: "correct horse" },
        { autocomplete: "url", value: "https://example.test/login" },
      ]),
      "login",
      "https://example.test",
      host,
    );
    if (!("item" in result)) throw new Error(result.error);
    expect(result.item.kind).toBe("account");
    if (result.item.kind !== "account") throw new Error("not an account");
    expect(result.item.username).toBe("ada@example.test");
    expect(result.item.uris[0]?.uri).toBe("https://example.test");
    const password = result.item.methods.find((m) => m.type === "password");
    expect(password?.type).toBe("password");
    if (password?.type !== "password") throw new Error("no password");
    expect(password.secret).toBe("correct horse");
  });

  it("builds a card with brand, expiry and address notes", async () => {
    const result = await buildSaveItem(
      request([
        { autocomplete: "cc-name", value: "Ada Lovelace" },
        { autocomplete: "cc-number", value: "4242 4242 4242 4242" },
        { autocomplete: "cc-exp", value: "12/30" },
        { autocomplete: "cc-csc", value: "123" },
        { autocomplete: "address-level2", value: "Cambridge" },
      ]),
      "credit-card",
      "https://shop.example.test",
      host,
    );
    if (!("item" in result)) throw new Error(result.error);
    expect(result.item.kind).toBe("card");
    if (result.item.kind !== "card") throw new Error("not a card");
    expect(result.item.number).toBe("4242424242424242");
    expect(result.item.brand).toBe("Visa");
    expect(result.item.expMonth).toBe("12");
    expect(result.item.expYear).toBe("2030");
    expect(result.item.notes).toContain("City: Cambridge");
  });

  it("builds a crypto wallet from the loaded built-in pack", async () => {
    const result = await buildSaveItem(
      request([{ autocomplete: "crypto-address", value: "0xabc" }]),
      "crypto-wallet",
      "https://wallet.example.test",
      { installItemTypeDefinition: async () => ({ ok: false }) },
    );
    if (!("item" in result)) throw new Error(result.error);
    expect(result.item.kind).toBe("typed");
    expect(result.item.name).toBe("Example");
  });

  it("does not store a live one-time code as an authenticator seed", async () => {
    const result = await buildSaveItem(
      request([{ autocomplete: "one-time-code", value: "123456" }]),
      "login",
      "https://example.test",
      host,
    );
    if (!("item" in result)) throw new Error(result.error);
    expect(result.item.kind).toBe("account");
    if (result.item.kind !== "account") throw new Error("not an account");
    expect(
      result.item.methods.some((method) => method.type === "authenticator"),
    ).toBe(false);
  });
});
