import { describe, expect, it } from "vitest";
import { decodeSaveRequest, saveRequestField } from "./save-request.js";

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("save request", () => {
  it("decodes a login request with unicode notes", () => {
    const request = decodeSaveRequest(
      encode({
        title: "Example",
        fields: [
          { autocomplete: "username", value: "ada@example.test" },
          { autocomplete: "current-password", value: "correct horse" },
        ],
        notes: "clé de récupération",
      }),
    );
    expect(request?.title).toBe("Example");
    if (!request) throw new Error("request did not decode");
    expect(saveRequestField(request, "username")).toBe("ada@example.test");
    expect(request?.notes).toBe("clé de récupération");
  });

  it("rejects malformed, empty, oversized and non-JSON payloads", () => {
    expect(decodeSaveRequest("not base64")).toBeNull();
    expect(decodeSaveRequest(encode({ title: "", fields: [] }))).toBeNull();
    expect(decodeSaveRequest(encode({ title: "X", fields: [] }))).toBeNull();
    expect(
      decodeSaveRequest(encode({ title: "X", fields: [{ value: "x" }] })),
    ).toBeNull();
    expect(decodeSaveRequest("A".repeat(128 * 1024 + 1))).toBeNull();
  });
  it("accepts an empty optional notes field", () => {
    const encoded = btoa(
      JSON.stringify({
        title: "Example",
        fields: [{ autocomplete: "username", value: "ada" }],
        notes: "",
      }),
    );
    expect(decodeSaveRequest(encoded)).toEqual({
      title: "Example",
      fields: [{ autocomplete: "username", value: "ada" }],
      notes: "",
    });
  });
});
