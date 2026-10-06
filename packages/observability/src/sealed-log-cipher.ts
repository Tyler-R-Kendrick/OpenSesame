import { hkdfSync, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";

export const SEALED_LINE_PREFIX = "osl2.";
export const LEGACY_LINE_PREFIX = "osl1.";
export type LogKey = Uint8Array;
const scopes = new WeakMap<LogKey, string>();
const INFO = Buffer.from("opensesame:event-seal:kek:v2");
const PURPOSE = Buffer.from("sealed-log.line");
const LEGACY_AAD = Buffer.from("opensesame.log.v1");

export function bindLogKeyPath(key: LogKey, path: string): LogKey {
  const canonical = join(realpathSync(dirname(path)), basename(path));
  scopes.set(key, `local-key:${Buffer.from(canonical).toString("base64url")}`);
  return key;
}
function contextFor(key: LogKey) {
  const context = Buffer.from(`customer:${scopes.get(key) ?? ""}`);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(context.length));
  const intermediate = new Uint8Array(
    hkdfSync(
      "sha256",
      key,
      Buffer.alloc(0),
      Buffer.concat([INFO, context]),
      32,
    ),
  );
  try {
    return {
      kek: new Uint8Array(hkdfSync("sha256", intermediate, INFO, PURPOSE, 32)),
      aad: Buffer.concat([INFO, length, context, PURPOSE]),
    };
  } finally {
    intermediate.fill(0);
  }
}
export function sealLogLine(key: LogKey, line: string): string {
  const { kek, aad } = contextFor(key);
  const dek = randomBytes(32);
  try {
    const wrapNonce = randomBytes(24);
    const dataNonce = randomBytes(24);
    const wrapped = xchacha20poly1305(kek, wrapNonce, aad).encrypt(dek);
    const body = xchacha20poly1305(dek, dataNonce, aad).encrypt(
      Buffer.from(line),
    );
    return `${SEALED_LINE_PREFIX}${Buffer.concat([wrapNonce, wrapped, dataNonce, body]).toString("base64url")}`;
  } finally {
    dek.fill(0);
    kek.fill(0);
  }
}
export function openLogLine(key: LogKey, sealed: string): string | null {
  if (sealed.length > 32 * 1024 * 1024) return null;
  const text = sealed.trim();
  const legacy = text.startsWith(LEGACY_LINE_PREFIX);
  if (!legacy && !text.startsWith(SEALED_LINE_PREFIX)) return null;
  const encoded = text.slice(5);
  const packed = Buffer.from(encoded, "base64url");
  if (packed.toString("base64url") !== encoded) return null;
  try {
    if (legacy) {
      if (packed.length < 40) return null;
      return new TextDecoder("utf-8", { fatal: true }).decode(
        xchacha20poly1305(key, packed.subarray(0, 24), LEGACY_AAD).decrypt(
          packed.subarray(24),
        ),
      );
    }
    if (packed.length < 112) return null;
    const { kek, aad } = contextFor(key);
    let dek: Uint8Array | undefined;
    try {
      dek = xchacha20poly1305(kek, packed.subarray(0, 24), aad).decrypt(
        packed.subarray(24, 72),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(
        xchacha20poly1305(dek, packed.subarray(72, 96), aad).decrypt(
          packed.subarray(96),
        ),
      );
    } finally {
      dek?.fill(0);
      kek.fill(0);
    }
  } catch {
    return null;
  }
}
