import {
  type BoundaryObject,
  type BoundaryValue,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Credential Exchange Format (CXF) import.
 *
 * CXF is the FIDO Alliance Proposed Standard (August 2025) that every major
 * manager is converging on, and the only interchange format that carries a
 * **passkey as a passkey**. Everything else on this page either drops passkeys
 * or flattens them into an unusable note, so this is the adapter that makes
 * moving to and from another manager lossless rather than merely possible.
 *
 * The shape, outermost first:
 *
 * ```text
 * Header { version, exporter, timestamp, accounts[] }
 *   Account { username, email, collections[], items[] }
 *     Collection { title, items[], subcollections[] }   // membership by item id
 *     Item { id, creationAt, modifiedAt, title, tags, scope{urls}, credentials[] }
 *       Credential — basic-auth | passkey | totp | credit-card | note |
 *                    ssh-key | api-key | wifi | address | person-name |
 *                    file | custom-fields
 * ```
 *
 * Values are `EditableField { value, fieldType }`, where `fieldType` is
 * `string`, `concealed-string`, `email`, `date`, and so on — `concealed-string`
 * is what marks a field the UI must not show in the clear.
 *
 * One item can hold several credentials, which is how a login with a second
 * factor is expressed: a `basic-auth` and a `totp` under one item. The mapping
 * below therefore reads an item as a whole and decides its kind from the set
 * of credentials it carries, rather than emitting one draft per credential.
 */

import {
  type DraftItem,
  type ParseResult,
  type SkippedRecord,
  type TextImportAdapter,
  addField,
  addUri,
  draftCard,
  draftLogin,
  draftNote,
  draftPasskey,
  draftSecret,
  normaliseTotp,
  toIso,
} from "../types.js";

import { CXF_EXTENSION, CXF_TYPES, urlToB64 } from "../../export/cxf.js";

/**
 * Exporters differ on casing — the specification's prose names the types
 * `BasicAuth` and `SSHKey` while the wire form is kebab-case — so both are
 * accepted and normalised here. The second pattern is what keeps an acronym
 * from swallowing the word after it: `APIKey` has to become `api-key`, not
 * `apikey`.
 */
function credentialType(raw: string): string {
  const kebab = raw
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .replace(/_/gu, "-")
    .toLowerCase();
  return TYPE_ALIASES.get(kebab) ?? kebab;
}

/** Names whose kebab form still is not the discriminator CXF puts on the wire. */
const TYPE_ALIASES = new Map([
  ["wifi-credential", CXF_TYPES.wifi],
  ["credit-card-number", CXF_TYPES.creditCard],
]);

function obj(value: BoundaryValue): BoundaryObject | null {
  return isTypeofObject(value) && value !== null && !Array.isArray(value)
    ? overlapCast(value)
    : null;
}

function arr(value: BoundaryValue): BoundaryValue[] {
  return Array.isArray(value) ? value : [];
}

function str(value: BoundaryValue): string {
  return isString(value) ? value : "";
}

/** An `EditableField`, or a bare string where an exporter took the shortcut. */
function fieldValue(value: BoundaryValue) {
  if (isString(value)) return { text: value, hidden: false };
  const row = obj(value);
  if (row === null) return { text: "", hidden: false };
  return {
    text: str(row.value),
    hidden: str(row.fieldType) === "concealed-string",
  };
}

function fieldLabel(value: BoundaryValue, fallback: string): string {
  const row = obj(value);
  const label = row === null ? "" : str(row.label);
  return label === "" ? fallback : label;
}

/** `creationAt`/`modifiedAt` are epoch seconds; `toIso` already handles both. */
function timestamp(value: BoundaryValue): string | null {
  return isNumber(value) && value > 0 ? toIso(value) : null;
}

function ourExtension(credential: BoundaryObject): BoundaryObject | null {
  for (const raw of arr(credential.extensions)) {
    const row = obj(raw);
    if (row !== null && str(row.name) === CXF_EXTENSION) return row;
  }
  return null;
}

/** Rebuild the vault's TOTP value from CXF's separate parameters. */
function totpFrom(credential: BoundaryObject, title: string): string {
  const kept = str(ourExtension(credential)?.otpauth ?? "");
  if (kept !== "") return kept;
  const secret = normaliseTotp(str(credential.secret));
  if (secret === "") return "";
  const period = isNumber(credential.period) ? credential.period : 30;
  const digits = isNumber(credential.digits) ? credential.digits : 6;
  const algorithm = str(credential.algorithm).toLowerCase();
  const issuer = str(credential.issuer);
  if (
    period === 30 &&
    digits === 6 &&
    algorithm !== "sha256" &&
    algorithm !== "sha512" &&
    issuer === ""
  ) {
    return secret;
  }
  const params = new URLSearchParams({ secret });
  if (issuer !== "") params.set("issuer", issuer);
  if (period !== 30) params.set("period", String(period));
  if (digits !== 6) params.set("digits", String(digits));
  if (algorithm === "sha256" || algorithm === "sha512") {
    params.set("algorithm", algorithm.toUpperCase());
  }
  const account = str(credential.username);
  const label = account === "" ? title : `${title}:${account}`;
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/** `2031-07` → month and year, the two fields a card item actually holds. */
function splitExpiry(raw: string) {
  const match = /^(\d{4})-(\d{1,2})$/u.exec(raw.trim());
  if (match === null) return { month: "", year: "" };
  return { month: String(Number(match[2])).padStart(2, "0"), year: match[1] };
}

type Bucket = {
  byType: Map<string, BoundaryObject>;
  /** Custom-field credentials, which may appear more than once per item. */
  customFields: BoundaryObject[];
  unsupported: string[];
};

function bucketCredentials(item: BoundaryObject): Bucket {
  const byType = new Map<string, BoundaryObject>();
  const customFields: BoundaryObject[] = [];
  const unsupported: string[] = [];
  for (const raw of arr(item.credentials)) {
    const credential = obj(raw);
    if (credential === null) continue;
    const type = credentialType(str(credential.type));
    if (type === CXF_TYPES.customFields) {
      customFields.push(credential);
      continue;
    }
    if (!byType.has(type)) byType.set(type, credential);
    if (
      type !== CXF_TYPES.basicAuth &&
      type !== CXF_TYPES.passkey &&
      type !== CXF_TYPES.totp &&
      type !== CXF_TYPES.creditCard &&
      type !== CXF_TYPES.note &&
      type !== CXF_TYPES.sshKey &&
      type !== CXF_TYPES.apiKey
    ) {
      unsupported.push(type);
    }
  }
  return { byType, customFields, unsupported };
}

function baseFor(bucket: Bucket, title: string): DraftItem | null {
  const { byType } = bucket;
  if (byType.has(CXF_TYPES.passkey)) return draftPasskey(title);
  if (byType.has(CXF_TYPES.basicAuth) || byType.has(CXF_TYPES.totp)) {
    return draftLogin(title);
  }
  if (byType.has(CXF_TYPES.creditCard)) return draftCard(title);
  if (byType.has(CXF_TYPES.sshKey) || byType.has(CXF_TYPES.apiKey)) {
    return draftSecret(title);
  }
  if (byType.has(CXF_TYPES.note)) return draftNote(title);
  return null;
}

function applyLogin(
  item: DraftItem,
  bucket: Bucket,
  title: string,
  urls: string[],
): void {
  if (item.kind !== "login") return;
  const basic = bucket.byType.get(CXF_TYPES.basicAuth);
  if (basic !== undefined) {
    item.username = fieldValue(basic.username).text;
    item.password = fieldValue(basic.password).text;
  }
  const totp = bucket.byType.get(CXF_TYPES.totp);
  if (totp !== undefined) item.totp = totpFrom(totp, title);
  for (const url of urls) addUri(item, url);
}

function applyPasskey(item: DraftItem, bucket: Bucket): void {
  if (item.kind !== "passkey") return;
  const passkey = bucket.byType.get(CXF_TYPES.passkey);
  if (passkey === undefined) return;
  const extension = ourExtension(passkey);
  item.rpId = str(passkey.rpId);
  item.username =
    str(passkey.username) !== ""
      ? str(passkey.username)
      : str(passkey.userDisplayName);
  item.credentialIdB64 = urlToB64(str(passkey.credentialId));
  // CXF's `key` is a private key. This vault has never held one and will not
  // start now; only the public half, when the exporter carried it, is kept.
  item.publicKeyB64 = urlToB64(str(extension?.publicKey ?? ""));
  item.authenticator =
    str(extension?.authenticator) === "cross-platform"
      ? "cross-platform"
      : "platform";
}

function applyCard(item: DraftItem, bucket: Bucket): void {
  if (item.kind !== "card") return;
  const card = bucket.byType.get(CXF_TYPES.creditCard);
  if (card === undefined) return;
  item.number = fieldValue(card.number).text;
  item.cardholder = fieldValue(card.fullName).text;
  item.brand = fieldValue(card.cardType).text;
  item.code = fieldValue(card.verificationNumber).text;
  const { month, year } = splitExpiry(fieldValue(card.expiryDate).text);
  item.expMonth = month;
  item.expYear = year;
}

function applySecret(item: DraftItem, bucket: Bucket): void {
  if (item.kind !== "secret") return;
  const apiKey = bucket.byType.get(CXF_TYPES.apiKey);
  if (apiKey !== undefined) {
    item.value = fieldValue(apiKey.key).text;
    const connectionRef = str(ourExtension(apiKey)?.connectionRef ?? "");
    if (connectionRef !== "") {
      addField(item, "Connection", connectionRef);
    }
    const username = str(apiKey.username);
    if (username !== "") addField(item, "Username", username);
    return;
  }
  const sshKey = bucket.byType.get(CXF_TYPES.sshKey);
  if (sshKey === undefined) return;
  // The private key is the secret; the rest is metadata that would be lost
  // entirely if it were not typed onto the item.
  item.value = fieldValue(sshKey.privateKey).text;
  addField(item, "Key type", str(sshKey.keyType));
  addField(item, "Comment", str(sshKey.keyComment));
}

const UNSUPPORTED_REASON = new Map<string, string>([
  [
    CXF_TYPES.wifi,
    "A Wi-Fi network credential has no matching item in this vault.",
  ],
  [
    CXF_TYPES.address,
    "An address is personal data rather than a credential, and this vault has nowhere to put it.",
  ],
  [
    CXF_TYPES.personName,
    "A person's name is personal data rather than a credential, and this vault has nowhere to put it.",
  ],
  [
    CXF_TYPES.file,
    "This vault stores fields, not files, so an attached file cannot be imported.",
  ],
]);

function reasonFor(types: string[]): string {
  const named = types
    .map((type) => UNSUPPORTED_REASON.get(type))
    .filter((reason): reason is string => reason !== undefined);
  return named.length > 0
    ? named[0]
    : `This vault has no item that can hold a ${types[0] ?? "credential"} credential.`;
}

function isCxfDocument(json: BoundaryValue): boolean {
  const row = obj(json);
  if (row === null) return false;
  if (!("accounts" in row) || !Array.isArray(row.accounts)) return false;
  // `version` and `exporter` together are what tell a CXF document apart from
  // any other JSON that happens to have an `accounts` array.
  return "version" in row && "exporter" in row;
}

export const fidoCxf: TextImportAdapter = {
  id: "fido-cxf",
  label: "Credential Exchange Format (.json)",
  shortName: "CXF",
  hint: "Any manager that supports the FIDO Credential Exchange Format. It is the only export that carries passkeys.",
  accepts: "text",

  detect: ({ json }) => isCxfDocument(json),

  parse: ({ json }): ParseResult => {
    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];
    const warnings: string[] = [];
    const document = obj(json);
    if (document === null || !isCxfDocument(json)) {
      return { source: "fido-cxf", items, skipped, warnings };
    }

    let referencedPrivateKey = false;

    for (const rawAccount of arr(document.accounts)) {
      const account = obj(rawAccount);
      if (account === null) continue;

      // Collection membership is by item id, and a subcollection is a level of
      // nesting this vault's flat folders express with a separator.
      const folderOf = new Map<string, string>();
      const walk = (
        rawCollection: BoundaryValue,
        path: readonly string[],
      ): void => {
        const collection = obj(rawCollection);
        if (collection === null) return;
        const title = str(collection.title).trim();
        const here = title === "" ? [...path] : [...path, title];
        const name = here.join("/");
        for (const rawLink of arr(collection.items)) {
          const id = isString(rawLink)
            ? rawLink
            : str(obj(rawLink)?.item ?? "");
          if (id !== "" && name !== "" && !folderOf.has(id)) {
            folderOf.set(id, name);
          }
        }
        for (const child of arr(collection.subcollections)) walk(child, here);
      };
      for (const collection of arr(account.collections)) walk(collection, []);

      for (const rawItem of arr(account.items)) {
        const row = obj(rawItem);
        if (row === null) continue;
        const title = str(row.title).trim() || "Untitled";
        const bucket = bucketCredentials(row);
        const item = baseFor(bucket, title);
        if (item === null) {
          skipped.push({ name: title, reason: reasonFor(bucket.unsupported) });
          continue;
        }

        const scope = obj(row.scope);
        const urls = arr(scope?.urls ?? null)
          .map(str)
          .filter((url) => url !== "");

        applyLogin(item, bucket, title, urls);
        applyPasskey(item, bucket);
        applyCard(item, bucket);
        applySecret(item, bucket);

        const note = bucket.byType.get(CXF_TYPES.note);
        if (note !== undefined) item.notes = fieldValue(note.content).text;

        for (const credential of bucket.customFields) {
          for (const raw of arr(credential.fields)) {
            const value = fieldValue(raw);
            addField(item, fieldLabel(raw, "Field"), value.text, value.hidden);
          }
        }

        // A URL on an item this vault models as something other than a login
        // would otherwise be dropped outright.
        if (item.kind !== "login") {
          for (const url of urls) addField(item, "Website", url);
        }

        const tags = arr(row.tags)
          .map(str)
          .filter((tag) => tag !== "");
        if (tags.length > 0) addField(item, "Tags", tags.join(", "));

        item.folder = folderOf.get(str(row.id)) ?? null;
        item.favorite = row.favorite === true;
        item.createdAt = timestamp(row.creationAt);
        item.updatedAt = timestamp(row.modifiedAt);

        if (bucket.unsupported.length > 0) {
          skipped.push({
            name: title,
            reason: `${reasonFor(bucket.unsupported)} The rest of the item was imported.`,
          });
        }
        if (
          item.kind === "passkey" &&
          str(bucket.byType.get(CXF_TYPES.passkey)?.key ?? "") !== ""
        ) {
          referencedPrivateKey = true;
        }

        items.push(item);
      }
    }

    if (referencedPrivateKey) {
      warnings.push(
        "This file carried passkey private keys. They were not imported — this vault never holds one — so those credentials come in as references and have to be registered again.",
      );
    }

    return { source: "fido-cxf", items, skipped, warnings };
  },
};
