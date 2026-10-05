import { type BoundaryObject, isNumber } from "@opensesame/os-domain";
import { CXF_TYPES } from "../../export/cxf.js";
import {
  type DraftAccount,
  type DraftItem,
  addUri,
  normaliseTotp,
} from "../types.js";
import { type Bucket, fieldValue, ourExtension, str } from "./cxf-fields.js";

type TotpSettings = {
  period: number;
  digits: number;
  algorithm: string;
  issuer: string;
};

function totpSettings(credential: BoundaryObject): TotpSettings {
  return {
    period: isNumber(credential.period) ? credential.period : 30,
    digits: isNumber(credential.digits) ? credential.digits : 6,
    algorithm: str(credential.algorithm).toLowerCase(),
    issuer: str(credential.issuer),
  };
}

const STRONG = new Set(["sha256", "sha512"]);

function isDefaultTotp({ period, digits, algorithm, issuer }: TotpSettings) {
  return (
    period === 30 && digits === 6 && !STRONG.has(algorithm) && issuer === ""
  );
}

function otpauthUri(
  secret: string,
  settings: TotpSettings,
  label: string,
): string {
  const params = new URLSearchParams({ secret });
  if (settings.issuer !== "") params.set("issuer", settings.issuer);
  if (settings.period !== 30) params.set("period", String(settings.period));
  if (settings.digits !== 6) params.set("digits", String(settings.digits));
  if (STRONG.has(settings.algorithm)) {
    params.set("algorithm", settings.algorithm.toUpperCase());
  }
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/** Rebuild the vault's TOTP value from CXF's separate parameters. */
function totpFrom(credential: BoundaryObject, title: string): string {
  const kept = str(ourExtension(credential)?.otpauth ?? "");
  if (kept !== "") return kept;
  const secret = normaliseTotp(str(credential.secret));
  if (secret === "") return "";
  const settings = totpSettings(credential);
  if (isDefaultTotp(settings)) return secret;
  const account = str(credential.username);
  return otpauthUri(
    secret,
    settings,
    account === "" ? title : `${title}:${account}`,
  );
}

/** The first `basic-auth` fills the draft's password; the rest are methods. */
function applyPasswords(item: DraftAccount, basics: BoundaryObject[]): void {
  let taken = false;
  for (const basic of basics) {
    if (item.username === "") item.username = fieldValue(basic.username).text;
    // A `basic-auth` that names no password (an export withheld it) is a
    // username and nothing else.
    if (basic.password === undefined) continue;
    const password = fieldValue(basic.password).text;
    if (!taken) {
      item.password = password;
      taken = true;
    } else if (password !== "") {
      item.methods.push({ type: "password", secret: password });
    }
  }
}

function applySeeds(
  item: DraftAccount,
  seeds: BoundaryObject[],
  title: string,
): void {
  let taken = false;
  for (const credential of seeds) {
    const seed = totpFrom(credential, title);
    if (seed === "") continue;
    if (taken) item.methods.push({ type: "authenticator", secret: seed });
    else item.totp = seed;
    taken = true;
  }
}

function applyKeys(item: DraftAccount, keys: BoundaryObject[]): void {
  for (const credential of keys) {
    const key = fieldValue(credential.key).text;
    if (key === "") continue;
    item.methods.push({
      type: "api-key",
      key,
      header: str(ourExtension(credential)?.header ?? ""),
    });
  }
}

/**
 * An account's login methods (ADR 0168). The first `basic-auth` and the first
 * `totp` fill the draft's own password and seed; every further credential, and
 * every `api-key`, becomes a method beside them.
 */
export function applyAccount(
  item: DraftItem,
  bucket: Bucket,
  title: string,
  urls: string[],
): void {
  if (item.kind !== "account") return;
  applyPasswords(item, bucket.byType.get(CXF_TYPES.basicAuth) ?? []);
  applySeeds(item, bucket.byType.get(CXF_TYPES.totp) ?? [], title);
  applyKeys(item, bucket.byType.get(CXF_TYPES.apiKey) ?? []);
  for (const url of urls) addUri(item, url);
}
