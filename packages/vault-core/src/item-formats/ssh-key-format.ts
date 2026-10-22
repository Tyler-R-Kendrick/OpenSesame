/** OpenSSH key shapes: a structural parser and a synthetic ed25519 key pair. */
import { isString } from "@opensesame/os-domain";
import type { FieldValues } from "@opensesame/vault-item-types";
import { b64ToBytes, bytesToB64 } from "../bytes.js";
import { inspectPrivateKeyPem } from "../openssl/keys.js";
import type { Random } from "./random.js";
import type { ItemFormat } from "./types.js";

const PUBLIC =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/=]+)(?: (.+))?$/u;
const PRIVATE =
  /^-----BEGIN ((?:OPENSSH|RSA|EC|DSA) PRIVATE KEY)-----[\s\S]+-----END \1-----$/u;

function pair(values: FieldValues): Record<string, string> {
  const value = values.keyPair;
  return value === undefined || isString(value) || Array.isArray(value)
    ? {}
    : value;
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function keyTypeOf(name: string): string {
  if (name === "ssh-rsa") return "rsa";
  if (name === "sk-ssh-ed25519@openssh.com") return "ed25519-sk";
  if (name === "sk-ecdsa-sha2-nistp256@openssh.com") return "ecdsa-sk";
  if (name.startsWith("ecdsa-sha2-")) return "ecdsa";
  return "ed25519";
}

/** SSH wire strings are uint32 length followed by that many bytes. */
function readString(
  bytes: Uint8Array,
  offset: number,
): { value: Uint8Array; next: number } | null {
  if (offset + 4 > bytes.length) return null;
  const length =
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0);
  const start = offset + 4;
  const end = start + length;
  if (length < 0 || end > bytes.length) return null;
  return { value: bytes.slice(start, end), next: end };
}

function nonEmpty(value: Uint8Array | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function validRsa(bytes: Uint8Array, offset: number): boolean {
  const exponent = readString(bytes, offset);
  const modulus = readString(bytes, exponent?.next ?? bytes.length);
  return nonEmpty(exponent?.value) && nonEmpty(modulus?.value);
}

function validEcdsa(bytes: Uint8Array, offset: number): boolean {
  const curve = readString(bytes, offset);
  const point = readString(bytes, curve?.next ?? bytes.length);
  return nonEmpty(curve?.value) && nonEmpty(point?.value);
}

function validSecurityKey(bytes: Uint8Array, offset: number): boolean {
  const key = readString(bytes, offset);
  const application = readString(bytes, key?.next ?? bytes.length);
  return nonEmpty(key?.value) && nonEmpty(application?.value);
}

function validEd25519(bytes: Uint8Array, offset: number): boolean {
  const key = readString(bytes, offset);
  return key?.value.length === 32 && key.next === bytes.length;
}

function validPublicBlob(name: string, encoded: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(encoded);
  } catch {
    return false;
  }
  const type = readString(bytes, 0);
  if (!type || new TextDecoder().decode(type.value) !== name) return false;
  if (name === "ssh-rsa") return validRsa(bytes, type.next);
  if (name.startsWith("ecdsa-sha2-")) return validEcdsa(bytes, type.next);
  if (name.startsWith("sk-")) return validSecurityKey(bytes, type.next);
  return validEd25519(bytes, type.next);
}

function writeString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function blob(random: Random): Uint8Array {
  const name = new TextEncoder().encode("ssh-ed25519");
  const key = random.bytes(32);
  const first = writeString(name);
  const second = writeString(key);
  const out = new Uint8Array(first.length + second.length);
  out.set(first);
  out.set(second, first.length);
  return out;
}

export const sshKeyFormat: ItemFormat = {
  id: "ssh-key",
  typeId: "ssh-key",
  label: "SSH key",
  specificity: 100,
  parse(value) {
    const raw = value.trim();
    const publicMatch = PUBLIC.exec(raw);
    if (publicMatch) {
      const name = publicMatch[1] ?? "";
      const encoded = publicMatch[2] ?? "";
      if (!validPublicBlob(name, encoded)) return null;
      return {
        keyType: keyTypeOf(name),
        keyPair: {
          publicKey: `${name} ${encoded}`,
          privateKey: "",
        },
        comment: publicMatch[3] ?? "",
      };
    }
    const privateMatch = PRIVATE.exec(raw);
    if (!privateMatch) return null;
    const inspected = inspectPrivateKeyPem(raw);
    if (inspected === null) return null;
    return {
      keyType:
        inspected.algorithm === "ec"
          ? "ecdsa"
          : inspected.algorithm === "openssh" ||
              inspected.algorithm === "unknown"
            ? ""
            : inspected.algorithm,
      keyPair: { publicKey: "", privateKey: raw },
      comment: "",
    };
  },
  generate({ random }): FieldValues {
    const publicKey = `ssh-ed25519 ${bytesToB64(blob(random))} synthetic@example.test`;
    return {
      keyType: "ed25519",
      keyPair: { publicKey, privateKey: "" },
      comment: "synthetic@example.test",
    };
  },
  canonical: (values) => {
    const keyPair = pair(values);
    return trimToNull(keyPair.privateKey || keyPair.publicKey || "");
  },
};
