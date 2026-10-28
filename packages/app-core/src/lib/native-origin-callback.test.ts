import { describe, expect, it } from "vitest";
import { captureNativeAuthCode } from "../browser/native-auth-message.js";

type ReceiptPart = { alg: "EdDSA" } | { state: string };

function receipt(state: string): string {
  const part = (value: ReceiptPart) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part({ state })}.signature`;
}
describe("Origin static callback transport", () => {
  it("carries the receipt as opaque material and routes only by its state", () => {
    const token = receipt("origin-state-with-at-least-32-characters");
    expect(
      captureNativeAuthCode(
        new URL(
          `https://selfhost.example/auth/native-connector.html?installation_receipt=${encodeURIComponent(token)}`,
        ),
      ),
    ).toEqual({
      state: "origin-state-with-at-least-32-characters",
      code: token,
      error: false,
    });
  });
  it("refuses mixed callback dialects and malformed receipts", () => {
    expect(
      captureNativeAuthCode(
        new URL(
          "https://selfhost.example/auth/native-connector.html?installation_receipt=not-a-jwt",
        ),
      ),
    ).toBeNull();
    const token = receipt("origin-state-with-at-least-32-characters");
    expect(
      captureNativeAuthCode(
        new URL(
          `https://selfhost.example/auth/native-connector.html?installation_receipt=${encodeURIComponent(token)}&code=oauth-code`,
        ),
      ),
    ).toBeNull();
  });
});
