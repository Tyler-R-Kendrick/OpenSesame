/**
 * Item-type formats: the closed parsers and generators for values that have a
 * standard shape. A manifest still names fields, not algorithms (ADR 0087);
 * these are platform algorithms, and a synthetic generator never contacts an
 * issuer or proves that a credential is live.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import type { JsonValue } from "@opensesame/os-domain";
import type { FieldValues } from "@opensesame/vault-item-types";
import { b64urlToBytes, bytesToB64url } from "../bytes.js";
import { cardChecksumValid, detectCardBrand } from "../card.js";
import { inspectCertificateBundle } from "../openssl/x509.js";
import { parseTotp } from "../totp.js";
import { apiKeyFormats } from "./api-key-formats.js";
import { identityDocumentFormat } from "./identity-document-format.js";
import { passportFormat } from "./passport-format.js";
import type { Random } from "./random.js";
import { sshKeyFormat } from "./ssh-key-format.js";
import type { ItemFormat } from "./types.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function text(values: FieldValues, id: string): string {
  const value = values[id];
  return isString(value) ? value : "";
}

function textList(values: FieldValues, id: string): string[] {
  const value = values[id];
  return Array.isArray(value) ? value.filter(isString) : [];
}

function record(values: FieldValues, id: string): Record<string, string> {
  const value = values[id];
  return value === undefined || isString(value) || Array.isArray(value)
    ? {}
    : value;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((value >>> bits) & 31);
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

function utf8(textValue: string): Uint8Array {
  return new TextEncoder().encode(textValue);
}

function b64urlJson(value: JsonValue): string {
  return bytesToB64url(utf8(JSON.stringify(value)));
}

function readB64urlJson(segment: string): JsonValue {
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  const json = new TextDecoder().decode(b64urlToBytes(padded));
  return overlapCast(JSON.parse(json));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Public scheme test numbers; never a random PAN that might belong to someone. */
const TEST_CARD_NUMBERS = [
  "4242424242424242",
  "5555555555554444",
  "378282246310005",
  "6011111111111117",
] as const;

function cardNumber(random: Random): string {
  return (
    TEST_CARD_NUMBERS[random.int(TEST_CARD_NUMBERS.length)] ??
    TEST_CARD_NUMBERS[0]
  );
}

type CardExpiry = { month: string; year: string };

function futureExpiry(now: Date): CardExpiry {
  const date = new Date(now.getTime());
  date.setUTCFullYear(date.getUTCFullYear() + 2);
  return {
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    year: String(date.getUTCFullYear()),
  };
}

const cardFormat: ItemFormat = {
  id: "payment-card",
  typeId: "card",
  label: "Payment card",
  specificity: 100,
  parse(value) {
    const digits = value.replaceAll(/[ -]/gu, "");
    if (!/^\d{12,19}$/u.test(digits) || !cardChecksumValid(digits)) return null;
    const brand = detectCardBrand(digits);
    if (!brand) return null;
    return { number: digits, brand: brand.name };
  },
  generate({ random, now }) {
    const number = cardNumber(random);
    const brand = detectCardBrand(number);
    const expiry = futureExpiry(now);
    return {
      cardholder: "OpenSesame Test",
      brand: brand?.name ?? "Visa",
      number,
      expMonth: expiry.month,
      expYear: expiry.year,
      code: random.digits(brand?.securityCodeLength ?? 3),
    };
  },
  canonical: (values) => trimToNull(text(values, "number")),
};

function mod97(value: string): number {
  let remainder = 0;
  for (const char of value) {
    if (char >= "0" && char <= "9") {
      remainder = (remainder * 10 + Number(char)) % 97;
    } else {
      const code = char.charCodeAt(0) - 55;
      remainder = (remainder * 100 + code) % 97;
    }
  }
  return remainder;
}

function ibanCheckDigits(country: string, bban: string): string {
  const check = 98 - mod97(`${bban}${country}00`);
  return String(check).padStart(2, "0");
}

function validIban(value: string): boolean {
  return (
    /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(value) &&
    mod97(`${value.slice(4)}${value.slice(0, 4)}`) === 1
  );
}

function abaValid(value: string): boolean {
  if (!/^\d{9}$/u.test(value)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7];
  const sum = weights.reduce(
    (total, weight, index) => total + weight * Number(value.charAt(index)),
    0,
  );
  return (10 - (sum % 10)) % 10 === Number(value.charAt(8));
}

function abaNumber(random: Random): string {
  const body = `01${random.digits(6)}`;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7];
  const sum = weights.reduce(
    (total, weight, index) => total + weight * Number(body.charAt(index)),
    0,
  );
  return `${body}${(10 - (sum % 10)) % 10}`;
}

const ibanFormat: ItemFormat = {
  id: "iban",
  typeId: "bank-account",
  label: "IBAN",
  specificity: 95,
  parse(value) {
    const iban = value.replaceAll(/\s/gu, "").toUpperCase();
    return validIban(iban) ? { iban } : null;
  },
  generate({ random }) {
    const bban = `${random.string(UPPER, 4)}${random.digits(14)}`;
    return {
      bank: "OpenSesame Test Bank",
      iban: `GB${ibanCheckDigits("GB", bban)}${bban}`,
    };
  },
  canonical: (values) => trimToNull(text(values, "iban")),
};

const abaFormat: ItemFormat = {
  id: "aba-routing-number",
  typeId: "bank-account",
  label: "ABA routing number",
  specificity: 45,
  parse(value) {
    const routingNumber = value.replaceAll(/[\s-]/gu, "");
    return abaValid(routingNumber) ? { routingNumber } : null;
  },
  generate({ random }) {
    return { bank: "OpenSesame Test Bank", routingNumber: abaNumber(random) };
  },
  canonical: (values) => trimToNull(text(values, "routingNumber")),
};

const totpFormat: ItemFormat = {
  id: "totp",
  typeId: "authenticator",
  label: "TOTP authenticator",
  specificity: 60,
  parse(value) {
    const raw = value.trim();
    // Base32 has a small alphabet. Requiring it, rather than letting the TOTP
    // decoder normalise arbitrary text, keeps prose and card numbers out.
    const compact = raw.replaceAll(/\s/gu, "");
    if (!raw.startsWith("otpauth://") && !/^[A-Z2-7]{8,}=*$/u.test(compact))
      return null;
    try {
      parseTotp(raw);
      return { totp: raw };
    } catch {
      return null;
    }
  },
  generate({ random }) {
    const secret = base32(random.bytes(20));
    return {
      totp: `otpauth://totp/OpenSesame:test?secret=${secret}&issuer=OpenSesame&algorithm=SHA1&digits=6&period=30`,
    };
  },
  canonical: (values) => trimToNull(text(values, "totp")),
};

function isJwtBearer(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) return false;
  try {
    return (
      isJsonObject(readB64urlJson(parts[0] ?? "")) &&
      isJsonObject(readB64urlJson(parts[1] ?? ""))
    );
  } catch {
    return false;
  }
}

const jwtFormat: ItemFormat = {
  id: "jwt",
  typeId: "token",
  label: "JWT bearer token",
  specificity: 90,
  parse(value) {
    const token = value.trim();
    return isJwtBearer(token) ? { token } : null;
  },
  generate({ now }) {
    return {
      token: `${b64urlJson({ alg: "none", typ: "JWT" })}.${b64urlJson({
        sub: "opensesame-test",
        iat: Math.floor(now.getTime() / 1000),
      })}.${b64urlJson({ synthetic: true })}`,
    };
  },
  canonical: (values) => trimToNull(text(values, "token")),
};

const DATABASE_SCHEMES = new Map<string, string>([
  ["postgres", "postgresql"],
  ["postgresql", "postgresql"],
  ["mysql", "mysql"],
  ["mariadb", "mariadb"],
  ["mongodb", "mongodb"],
  ["mongodb+srv", "mongodb"],
  ["redis", "redis"],
  ["rediss", "redis"],
  ["sqlserver", "sqlserver"],
]);

const DEFAULT_DATABASE_PORTS = new Map<string, string>([
  ["postgresql", "5432"],
  ["mysql", "3306"],
  ["mariadb", "3306"],
  ["mongodb", "27017"],
  ["redis", "6379"],
  ["sqlserver", "1433"],
]);

const databaseFormat: ItemFormat = {
  id: "database-url",
  typeId: "database",
  label: "Database connection URL",
  specificity: 85,
  parse(value) {
    const connectionString = value.trim();
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      return null;
    }
    const scheme = url.protocol.replace(/:$/u, "");
    const engine = DATABASE_SCHEMES.get(scheme);
    if (!engine) return null;
    const databaseName = url.pathname.replace(/^\//u, "");
    return {
      engine,
      endpoint: {
        host: url.hostname,
        port: url.port || (DEFAULT_DATABASE_PORTS.get(engine) ?? ""),
      },
      databaseName,
      username: safeDecode(url.username),
      password: safeDecode(url.password),
      connectionString,
    };
  },
  generate({ random }) {
    const password = random.string(ALNUM, 20);
    const connectionString = `postgresql://demo:${password}@db.example.test:5432/app`;
    return {
      engine: "postgresql",
      endpoint: { host: "db.example.test", port: "5432" },
      databaseName: "app",
      username: "demo",
      password,
      connectionString,
    };
  },
  canonical: (values) => trimToNull(text(values, "connectionString")),
};

const serverFormat: ItemFormat = {
  id: "ssh-url",
  typeId: "server",
  label: "SSH server URL",
  specificity: 70,
  parse(value) {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      return null;
    }
    if (url.protocol !== "ssh:" || url.hostname === "") return null;
    return {
      endpoint: { host: url.hostname, port: url.port || "22" },
      username: safeDecode(url.username),
      password: safeDecode(url.password),
      protocol: "ssh",
    };
  },
  generate({ random }) {
    const username = `demo${random.string("0123456789", 3)}`;
    return {
      endpoint: { host: "server.example.test", port: "22" },
      username,
      protocol: "ssh",
      password: random.string(ALNUM, 24),
    };
  },
  canonical: (values) => {
    const endpoint = record(values, "endpoint");
    const host = endpoint.host?.trim();
    if (!host) return null;
    const user = text(values, "username").trim();
    const password = text(values, "password").trim();
    const auth = user
      ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@`
      : "";
    const port = endpoint.port?.trim() || "22";
    return `ssh://${auth}${host}:${port}`;
  },
};

const VIN_ALPHABET = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ";
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_VALUES = new Map<string, number>([
  ["A", 1],
  ["B", 2],
  ["C", 3],
  ["D", 4],
  ["E", 5],
  ["F", 6],
  ["G", 7],
  ["H", 8],
  ["J", 1],
  ["K", 2],
  ["L", 3],
  ["M", 4],
  ["N", 5],
  ["P", 7],
  ["R", 9],
  ["S", 2],
  ["T", 3],
  ["U", 4],
  ["V", 5],
  ["W", 6],
  ["X", 7],
  ["Y", 8],
  ["Z", 9],
]);

function vinCheck(value: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/u.test(value)) return false;
  const sum = [...value].reduce((total, char, index) => {
    const weight = VIN_WEIGHTS[index] ?? 0;
    const digit = /\d/u.test(char) ? Number(char) : (VIN_VALUES.get(char) ?? 0);
    return total + weight * digit;
  }, 0);
  const check = sum % 11 === 10 ? "X" : String(sum % 11);
  return value.charAt(8) === check;
}

const vinFormat: ItemFormat = {
  id: "vin",
  typeId: "vehicle",
  label: "Vehicle identification number",
  specificity: 70,
  parse(value) {
    const vin = value.trim().toUpperCase();
    return vinCheck(vin) ? { vin } : null;
  },
  generate({ random, now }) {
    const body = random.string(VIN_ALPHABET, 17);
    const filled = `${body.slice(0, 8)}0${body.slice(9)}`;
    const sum = [...filled].reduce((total, char, index) => {
      const weight = VIN_WEIGHTS[index] ?? 0;
      const digit = /\d/u.test(char)
        ? Number(char)
        : (VIN_VALUES.get(char) ?? 0);
      return total + weight * digit;
    }, 0);
    const check = sum % 11 === 10 ? "X" : String(sum % 11);
    return {
      make: "OpenSesame Test",
      model: "Synthetic",
      year: String(now.getUTCFullYear()),
      vin: `${filled.slice(0, 8)}${check}${filled.slice(9)}`,
    };
  },
  canonical: (values) => trimToNull(text(values, "vin")),
};

function checksumAddress(lower: string): string {
  const hash = hex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let index = 0; index < lower.length; index += 1) {
    const char = lower.charAt(index);
    out +=
      /[a-f]/u.test(char) && Number.parseInt(hash.charAt(index), 16) >= 8
        ? char.toUpperCase()
        : char;
  }
  return out;
}

function evmAddress(value: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) return false;
  const body = value.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return checksumAddress(body.toLowerCase()) === value;
}

const evmFormat: ItemFormat = {
  id: "evm-address",
  typeId: "crypto-wallet",
  label: "Ethereum address",
  specificity: 70,
  parse(value) {
    const address = value.trim();
    return evmAddress(address)
      ? { addresses: [address], network: "ethereum" }
      : null;
  },
  generate({ random }) {
    const address = `0x${hex(random.bytes(20))}`;
    return {
      walletName: "OpenSesame Test Wallet",
      network: "ethereum",
      addresses: [checksumAddress(address.slice(2))],
    };
  },
  canonical: (values) => textList(values, "addresses")[0] ?? null,
};

const passkeyFormat: ItemFormat = {
  id: "passkey-credential-id",
  typeId: "passkey",
  label: "WebAuthn credential id",
  specificity: 15,
  parse(value) {
    const credentialIdB64 = value.trim();
    return /^[A-Za-z0-9_-]{22,1024}$/u.test(credentialIdB64)
      ? { credentialIdB64 }
      : null;
  },
  generate({ random }) {
    return {
      rpId: "example.test",
      username: "demo@example.test",
      credentialIdB64: bytesToB64url(random.bytes(32)),
      publicKeyB64: bytesToB64url(random.bytes(64)),
      authenticator: "platform",
    };
  },
  canonical: (values) => trimToNull(text(values, "credentialIdB64")),
};

function uuid(random: Random): string {
  const bytes = random.bytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const at = (index: number) =>
    (bytes[index] ?? 0).toString(16).padStart(2, "0");
  return `${at(0)}${at(1)}${at(2)}${at(3)}-${at(4)}${at(5)}-${at(6)}${at(7)}-${at(8)}${at(9)}-${at(10)}${at(11)}${at(12)}${at(13)}${at(14)}${at(15)}`;
}

const softwareLicenseFormat: ItemFormat = {
  id: "uuid-license-key",
  typeId: "software-license",
  label: "UUID licence key",
  specificity: 30,
  parse(value) {
    const licenseKey = value.trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      licenseKey,
    )
      ? { licenseKey, product: "OpenSesame Test" }
      : null;
  },
  generate({ random }) {
    return { product: "OpenSesame Test", licenseKey: uuid(random) };
  },
  canonical: (values) => trimToNull(text(values, "licenseKey")),
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

const emailFormat: ItemFormat = {
  id: "email-address",
  typeId: "email-account",
  label: "Email address",
  specificity: 10,
  parse(value) {
    const address = value.trim();
    return EMAIL.test(address) ? { address, username: address } : null;
  },
  generate({ random }) {
    const address = `demo+${random.hex(8)}@example.test`;
    return {
      address,
      username: address,
      incoming: { host: "imap.example.test", port: "993" },
      incomingProtocol: "imap",
      outgoing: { host: "smtp.example.test", port: "465" },
      security: "tls",
      password: random.string(ALNUM, 24),
    };
  },
  canonical: (values) => trimToNull(text(values, "address")),
};

function unescapeWifi(value: string): string {
  return value.replaceAll(/\\([\\;,:"])/gu, "$1");
}

/** Split on unescaped semicolons; an escaped `;` belongs to the field. */
function splitWifi(value: string): string[] {
  const parts: string[] = [];
  let part = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      part += `\\${char}`;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === ";") {
      parts.push(part);
      part = "";
    } else {
      part += char;
    }
  }
  if (escaped) part += "\\";
  parts.push(part);
  return parts;
}

function escapeWifi(value: string): string {
  return value.replaceAll(/([\\;,:"])/gu, "\\$1");
}

const WIFI_SECURITY = new Map<string, string>([
  ["WPA3", "wpa3"],
  ["WPA2", "wpa2"],
  ["WPA", "wpa"],
  ["WEP", "wep"],
  ["nopass", "open"],
]);

const wifiFormat: ItemFormat = {
  id: "wifi-qr",
  typeId: "wifi",
  label: "Wi-Fi QR payload",
  specificity: 95,
  parse(value) {
    const raw = value.trim();
    if (!raw.startsWith("WIFI:")) return null;
    const fields = new Map<string, string>();
    const body = raw.slice(5).replace(/;$/u, "");
    for (const part of splitWifi(body)) {
      if (part === "") continue;
      const at = part.indexOf(":");
      if (at <= 0) continue;
      fields.set(part.slice(0, at), unescapeWifi(part.slice(at + 1)));
    }
    const ssid = fields.get("S");
    const security = WIFI_SECURITY.get(fields.get("T") ?? "");
    if (!ssid || !security) return null;
    return {
      ssid,
      passphrase: fields.get("P") ?? "",
      security,
      hidden: fields.get("H") === "true" ? "true" : "",
    };
  },
  generate({ random }) {
    const passphrase = random.string(ALNUM, 24);
    return {
      ssid: "OpenSesame Test",
      passphrase,
      security: "wpa2",
      hidden: "",
      adminPassword: random.string(ALNUM, 20),
    };
  },
  canonical: (values) => {
    const ssid = text(values, "ssid");
    if (!ssid) return null;
    const security = text(values, "security");
    const qrType =
      security === "open"
        ? "nopass"
        : security === "wpa3"
          ? "WPA3"
          : security === "wpa2"
            ? "WPA2"
            : security === "wep"
              ? "WEP"
              : "WPA";
    return `WIFI:T:${qrType};S:${escapeWifi(ssid)};P:${escapeWifi(text(values, "passphrase"))};${text(values, "hidden") === "true" ? "H:true;" : ""};`;
  },
};

const giftCardFormat: ItemFormat = {
  id: "gift-card-number",
  typeId: "gift-card",
  label: "Gift-card number",
  specificity: 20,
  parse(value) {
    const cardNumber = value.replaceAll(/[\s-]/gu, "");
    return /^\d{12,19}$/u.test(cardNumber) ? { cardNumber } : null;
  },
  generate({ random }) {
    return {
      merchant: "OpenSesame Test Store",
      cardNumber: random.digits(16),
      pin: random.digits(4),
    };
  },
  canonical: (values) => trimToNull(text(values, "cardNumber")),
};

const backupCodesFormat: ItemFormat = {
  id: "backup-codes",
  typeId: "backup-codes",
  label: "Backup code list",
  specificity: 25,
  parse(value) {
    const codes = value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    return codes.length >= 4 &&
      codes.length <= 32 &&
      codes.every((code) => /^[A-Za-z0-9_-]{6,32}$/u.test(code))
      ? { codes: codes.join("\n") }
      : null;
  },
  generate({ random }) {
    const codes = Array.from(
      { length: 10 },
      () =>
        `${random.string("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4)}-${random.string("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4)}`,
    );
    return {
      service: "OpenSesame Test",
      account: "demo@example.test",
      codes: codes.join("\n"),
    };
  },
  canonical: (values) => trimToNull(text(values, "codes")),
};

const certificateFormat: ItemFormat = {
  id: "pem-certificate",
  typeId: "certificate",
  label: "PEM certificate",
  specificity: 100,
  parse(value) {
    const bundle = inspectCertificateBundle(value.trim());
    if (bundle === null || bundle.pem.length === 0) return null;
    const leaf = bundle.certificates[0];
    if (leaf === undefined) return null;
    return {
      certificatePem: bundle.pem[0] ?? "",
      caPem: bundle.pem.slice(1).join("\n"),
      commonName: leaf.subjectCommonName,
      dnsNames: leaf.dnsNames.join(", "),
      ipAddrs: leaf.ipAddrs.join(", "),
      serial: leaf.serial,
      notAfter: leaf.notAfter,
    };
  },
  canonical: (values) => trimToNull(text(values, "certificatePem")),
};
const secretFormat: ItemFormat = {
  id: "opaque-secret",
  typeId: "secret",
  label: "Opaque secret",
  specificity: 0,
  parse(value) {
    return value === "" ? null : { value };
  },
  generate({ random }) {
    return { value: random.string(`${ALNUM}_-`, 32) };
  },
  canonical: (values) => trimToNull(text(values, "value")),
};

const passwordFormat: ItemFormat = {
  id: "password",
  typeId: "password",
  label: "Password",
  specificity: 0,
  parse(value) {
    const password = value;
    return password.trim() === "" ? null : { password };
  },
  generate({ random }) {
    return { password: random.string(`${ALNUM}!@#$%^&*`, 24) };
  },
  canonical: (values) => trimToNull(text(values, "password")),
};

/** Every format that can be recognised from one value, most specific first. */
export const DETECTED_FORMATS: readonly ItemFormat[] = [
  passportFormat,
  identityDocumentFormat,
  certificateFormat,
  sshKeyFormat,
  wifiFormat,
  cardFormat,
  ibanFormat,
  totpFormat,
  jwtFormat,
  ...apiKeyFormats("api-key"),
  databaseFormat,
  serverFormat,
  vinFormat,
  evmFormat,
  abaFormat,
  softwareLicenseFormat,
  backupCodesFormat,
  giftCardFormat,
  emailFormat,
];

/** Formats that accept an exact type's value even when detection is too broad. */
export const TYPED_FORMATS: readonly ItemFormat[] = [
  ...DETECTED_FORMATS,
  ...apiKeyFormats("api-credential"),
  passkeyFormat,
  secretFormat,
  passwordFormat,
];

export function formatsForType(typeId: string): readonly ItemFormat[] {
  return TYPED_FORMATS.filter((format) => format.typeId === typeId);
}
