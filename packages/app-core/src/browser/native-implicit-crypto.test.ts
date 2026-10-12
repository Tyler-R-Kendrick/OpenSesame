import { expect, it } from "vitest";
import {
  createNativeImplicitKey,
  decryptNativeImplicitPayload,
  encryptNativeImplicitPayload,
} from "./native-implicit-crypto.js";
const payload = {
  accessToken: "private-approved-provider-access",
  tokenType: "Bearer" as const,
  expiresIn: 3600,
  scopes: ["identify"],
};
it("encrypts callback bearer material for one nonextractable initiating session", async () => {
  const receiver = await createNativeImplicitKey("discord", "n".repeat(43));
  const wire = await encryptNativeImplicitPayload(
    receiver.state,
    "discord",
    "https://selfhost.example/auth/native-implicit.html",
    payload,
  );
  expect(receiver.keys.privateKey.extractable).toBe(false);
  expect(receiver.state.length).toBeLessThanOrEqual(512);
  expect(JSON.stringify(wire)).not.toContain(payload.accessToken);
  expect(
    await decryptNativeImplicitPayload(
      receiver.keys,
      receiver.state,
      "discord",
      "https://selfhost.example/auth/native-implicit.html",
      wire,
    ),
  ).toEqual(payload);
});
it("prevents another tab's private key from reading intercepted ciphertext", async () => {
  const receiver = await createNativeImplicitKey("discord", "n".repeat(43));
  const other = await createNativeImplicitKey("discord", "o".repeat(43));
  const wire = await encryptNativeImplicitPayload(
    receiver.state,
    "discord",
    "https://selfhost.example/auth/native-implicit.html",
    payload,
  );
  await expect(
    decryptNativeImplicitPayload(
      other.keys,
      receiver.state,
      "discord",
      "https://selfhost.example/auth/native-implicit.html",
      wire,
    ),
  ).rejects.toThrow();
});
it("binds ciphertext to the exact provider, state and deployed callback", async () => {
  const receiver = await createNativeImplicitKey("discord", "n".repeat(43));
  const wire = await encryptNativeImplicitPayload(
    receiver.state,
    "discord",
    "https://selfhost.example/auth/native-implicit.html",
    payload,
  );
  await expect(
    decryptNativeImplicitPayload(
      receiver.keys,
      receiver.state,
      "discord",
      "https://selfhost.example/auth/other.html",
      wire,
    ),
  ).rejects.toThrow();
  await expect(
    decryptNativeImplicitPayload(
      receiver.keys,
      receiver.state,
      "reddit",
      "https://selfhost.example/auth/native-implicit.html",
      wire,
    ),
  ).rejects.toThrow();
  await expect(
    decryptNativeImplicitPayload(
      receiver.keys,
      `${receiver.state}x`,
      "discord",
      "https://selfhost.example/auth/native-implicit.html",
      wire,
    ),
  ).rejects.toThrow();
});
it("preserves bounded large observed credentials instead of exceeding its own envelope limit", async () => {
  const receiver = await createNativeImplicitKey("google", "n".repeat(43));
  const large = {
    accessToken: "a".repeat(32768),
    tokenType: "Bearer",
    expiresIn: 3600,
    scopes: Array.from(
      { length: 128 },
      (_, index) => `${index}:${"s".repeat(252)}`,
    ),
  };
  const wire = await encryptNativeImplicitPayload(
    receiver.state,
    "google",
    "https://selfhost.example/auth/native-google.html",
    large,
  );
  expect(wire.ciphertext.length).toBeGreaterThan(65536);
  expect(
    await decryptNativeImplicitPayload(
      receiver.keys,
      receiver.state,
      "google",
      "https://selfhost.example/auth/native-google.html",
      wire,
    ),
  ).toEqual(large);
});
