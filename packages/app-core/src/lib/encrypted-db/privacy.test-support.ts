/** Inspect clear storage structure separately from random opaque encodings. */
import { b64urlToBytes, bytesToB64url } from "@opensesame/vault-core";
import { expect } from "vitest";
import { z } from "zod";
import { AT_REST_OVERHEAD_BYTES } from "../at-rest/cipher.js";
import type { RawDisk } from "./edb.test-support.js";
import { MIN_PADDED } from "./rows.js";

const hex128 = z.string().regex(/^[0-9a-f]{32}$/u);
const sealed = z.string().regex(/^osr2\.[A-Za-z0-9_-]+$/u);
const stored = z.strictObject({
  c: sealed,
  x: z.array(
    z.union([
      hex128,
      z.tuple([
        z.string().regex(/^[0-9a-f]{16}$/u),
        z.string().regex(/^[0-9a-f]+$/u),
      ]),
    ]),
  ),
});

export function assertPrivateDisk(disk: RawDisk, plaintext: string[]): void {
  const decodedEnvelopes: string[] = [];
  for (const name of disk.names)
    expect(name).toMatch(/^opensesame-edb-[0-9a-f]{32}$/u);
  for (const layout of disk.layouts)
    expect(layout).toEqual({ stores: ["r"], indexes: ["x"] });
  for (const record of disk.records) {
    hex128.parse(record.key);
    const envelope = stored.parse(JSON.parse(record.value));
    const encoded = envelope.c.slice("osr2.".length);
    const bytes = b64urlToBytes(encoded);
    decodedEnvelopes.push(new TextDecoder().decode(bytes));
    expect(bytesToB64url(bytes)).toBe(encoded);
    expect(bytes.length).toBeGreaterThanOrEqual(
      AT_REST_OVERHEAD_BYTES + MIN_PADDED,
    );
  }
  // Short words can occur by chance in ciphertext or keyed pseudonyms. Full
  // planted values still detect plaintext copied anywhere on the raw disk.
  const raw = [JSON.stringify(disk), ...decodedEnvelopes]
    .join("\n")
    .toLowerCase();
  for (const value of plaintext) {
    expect(value.length).toBeGreaterThanOrEqual(12);
    expect(raw).not.toContain(value.toLowerCase());
  }
}
