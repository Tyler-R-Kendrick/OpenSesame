import { expect, it } from "vitest";
import { openFromRest, sealForRest, useClientAtRestKeys } from "./seal.js";

function packed(value: string): Uint8Array {
  return Uint8Array.from(atob(value.slice(5)), (character) =>
    character.charCodeAt(0),
  );
}
function stored(bytes: Uint8Array, prefix = "osc2."): string {
  return prefix + btoa(String.fromCharCode(...bytes));
}

it("wraps fresh data keys and authenticates the full frame and canonical context", async () => {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  useClientAtRestKeys(async () => key);
  const first = (await sealForRest("store", "customer-a", "secret")) ?? "";
  const second = (await sealForRest("store", "customer-a", "secret")) ?? "";
  const aad = new TextEncoder().encode(
    JSON.stringify(["opensesame.client-envelope.v2", "store", "customer-a"]),
  );
  const unwrap = (value: string) => {
    const bytes = packed(value);
    return crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad },
      key,
      bytes.subarray(12, 60),
    );
  };
  expect(new Uint8Array(await unwrap(first))).not.toEqual(
    new Uint8Array(await unwrap(second)),
  );
  for (let index = 0; index < packed(first).length; index += 1) {
    const changed = packed(first);
    changed[index] = (changed[index] ?? 0) ^ 1;
    expect(
      await openFromRest("store", "customer-a", stored(changed)),
    ).toBeNull();
  }
  expect(await openFromRest("store", "customer-b", first)).toBeNull();
  expect(
    await openFromRest("store", "customer-a", first.replace("osc2.", "osc1.")),
  ).toBeNull();
  expect(await openFromRest("store", "customer-a", "osc2.AA==")).toBeNull();
  expect(await openFromRest("store", "customer-a", "osc99.future")).toBeNull();
  const collision = (await sealForRest("a\0b", "c", "secret")) ?? "";
  expect(await openFromRest("a", "b\0c", collision)).toBeNull();
});

it("keeps legacy osc1 reads without writing new direct seals", async () => {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  useClientAtRestKeys(async () => key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(
          "opensesame.client-at-rest.v1\0store\0record",
        ),
      },
      key,
      new TextEncoder().encode("legacy"),
    ),
  );
  const bytes = new Uint8Array(iv.length + payload.length);
  bytes.set(iv);
  bytes.set(payload, iv.length);
  expect(await openFromRest("store", "record", stored(bytes, "osc1."))).toBe(
    "legacy",
  );
  expect(await sealForRest("store", "record", "legacy")).toMatch(/^osc2\./);
});
