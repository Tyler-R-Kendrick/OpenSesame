import { expect, it } from "vitest";
import { generatePasskeyAuthenticationOptions } from "../webauthn.js";

const rp = { rpID: "localhost", origin: "http://localhost:5180" };

it("returns configured ordered hints with genuine generated authentication options", async () => {
  const hints: Array<"security-key" | "hybrid"> = ["security-key", "hybrid"];
  const options = await generatePasskeyAuthenticationOptions({
    rp,
    hints,
    userVerification: "required",
    allowCredentialIds: ["Zml4dHVyZQ"],
  });
  expect(options.hints).toEqual(["security-key", "hybrid"]);
  expect(options.hints).not.toBe(hints);
  expect(options.rpId).toBe("localhost");
  expect(options.userVerification).toBe("required");
  expect(options.challenge.length).toBeGreaterThan(8);
  expect(options.allowCredentials).toMatchObject([
    { id: "Zml4dHVyZQ", type: "public-key" },
  ]);
  hints[0] = "hybrid";
  expect(options.hints).toEqual(["security-key", "hybrid"]);
});

it("keeps absent and empty hints out of ordinary options and generates independent challenges", async () => {
  const absent = await generatePasskeyAuthenticationOptions({ rp });
  const empty = await generatePasskeyAuthenticationOptions({ rp, hints: [] });
  expect(absent.hints).toBeUndefined();
  expect(empty.hints).toBeUndefined();
  expect(absent.userVerification).toBe("required");
  expect(empty.userVerification).toBe("required");
  expect(absent.challenge).not.toBe(empty.challenge);
});
