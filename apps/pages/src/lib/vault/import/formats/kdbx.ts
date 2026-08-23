/**
 * KeePass / KeePassXC database (`.kdbx`).
 *
 * Unlike every other importer here, the file is not text: it is a single
 * encrypted blob that has to be opened before anything can be read. That is
 * what the pipeline's `"binary"` accept mode and `needsPassword` answer exist
 * for — this adapter asks for the master password, then decrypts entirely in
 * this tab.
 *
 * # Why the codec is loaded lazily
 *
 * kdbxweb plus an Argon2 implementation is a large amount of code, and Argon2
 * arrives as WebAssembly. Someone who never imports a database should never
 * download it, and the service worker should never precache it, so both are
 * pulled in with `import()` inside `parse()` rather than at module scope.
 *
 * # Mapping contract (frozen — `crates/kdbx-bridge` implements the same one)
 *
 * - `Password` → the login's password.
 * - `UserName` → the login's username.
 * - `URL` → a login URI.
 * - `Notes` → the item's notes, newlines preserved.
 * - Every other KDBX string field → a custom field, name and value verbatim,
 *   hidden when KDBX marked it protected.
 * - TOTP, from either the `otp` field (an otpauth URI, or the KeeOtp
 *   `key=…&step=…` query form) or the KeePassXC `TimeOtp-*` attributes → the
 *   item's TOTP.
 * - Group path + `Title` → folder and name. The root group is the database
 *   itself and contributes no segment. Each segment is sanitised by
 *   `sanitiseSegment` below, and a logical path that collides with one already
 *   taken gets ` (2)`, ` (3)`, … appended to its name.
 *
 * `crates/kdbx-bridge/README.md` is the normative statement of that contract;
 * `fixtures/kdbx/roundtrip.kdbx` is the file both sides are tested against.
 * - KeePassXC `KPEX_PASSKEY_*` attributes → a passkey item, best effort. The
 *   private key KeePassXC stores in the entry is deliberately not imported;
 *   this vault never holds one.
 */

import {
  type DraftItem,
  type DraftLogin,
  type BinaryImportAdapter,
  type ParseResult,
  type SkippedRecord,
  addField,
  addUri,
  base64UrlToBase64,
  draftLogin,
  draftPasskey,
  normaliseTotp,
  passwordRequired,
} from "../types.js";

/** `0x9AA2D903 0xB54BFB67`, little-endian, at the head of every KDBX file. */
const MAGIC = [0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5];

/** Fields the mapping reads by name; everything else becomes a custom field. */
const NAMED_FIELDS = new Set(["Title", "UserName", "Password", "URL", "Notes"]);

/**
 * `/`, `\`, and Unicode's control category — the exact set Rust's
 * `char::is_control` covers — matched one character at a time so the pattern
 * needs no literal control characters of its own.
 */
const SEPARATOR_OR_CONTROL = /[/\\\p{Cc}]/u;

const PASSKEY_PREFIX = "KPEX_PASSKEY_";
const TIME_OTP_PREFIX = "TimeOtp-";

export class KdbxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KdbxImportError";
  }
}

export function hasKdbxMagic(bytes: Uint8Array | null): boolean {
  if (bytes === null || bytes.length < MAGIC.length) return false;
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * One segment of a group path, or an entry title, reduced to something a
 * folder name and an item name can both hold.
 *
 * This is the normative rule from `crates/kdbx-bridge` (`sanitize_segment`),
 * mirrored here character for character so the two implementations put the
 * same entry at the same place:
 *
 * - `/`, `\`, and any control character become `_`. A separator inside a name
 *   must not be able to forge a level of nesting.
 * - The result is trimmed.
 * - A segment left empty becomes `_`.
 * - A segment of nothing but dots becomes that many underscores, so `.` and
 *   `..` can never mean "the parent directory".
 */
export function sanitiseSegment(raw: string): string {
  const replaced = [...raw]
    .map((ch) => (SEPARATOR_OR_CONTROL.test(ch) ? "_" : ch))
    .join("");
  const trimmed = replaced.trim();
  if (trimmed === "") return "_";
  if (/^\.+$/u.test(trimmed)) return "_".repeat([...trimmed].length);
  return trimmed;
}

/** A KDBX field value is either a plain string or a protected one. */
type FieldValue = { text: string; protected: boolean };

type KdbxwebModule = typeof import("kdbxweb");

let codec: Promise<KdbxwebModule> | null = null;

/**
 * kdbxweb ships no Argon2 of its own, so one is handed to it. hash-wasm's is
 * WebAssembly, which is why this whole function sits behind `import()`.
 */
async function loadCodec(): Promise<KdbxwebModule> {
  codec ??= (async () => {
    const [imported, hashWasm] = await Promise.all([
      import("kdbxweb"),
      import("hash-wasm"),
    ]);
    const module =
      (imported as unknown as { default?: KdbxwebModule }).default ??
      (imported as KdbxwebModule);

    module.CryptoEngine.setArgon2Impl(
      async (
        password,
        salt,
        memory,
        iterations,
        length,
        parallelism,
        type,
        version,
      ) => {
        if (version !== 0x13) {
          throw new KdbxImportError(
            "This database uses Argon2 version 1.0, which this importer cannot compute. Open it in KeePassXC and save it again to upgrade the key derivation.",
          );
        }
        const argon2 =
          type === module.CryptoEngine.Argon2TypeArgon2id
            ? hashWasm.argon2id
            : hashWasm.argon2d;
        // kdbxweb has already converted the header's byte count to KiB, which
        // is the unit hash-wasm takes.
        const hash = await argon2({
          password: new Uint8Array(password),
          salt: new Uint8Array(salt),
          parallelism,
          iterations,
          memorySize: memory,
          hashLength: length,
          outputType: "binary",
        });
        return hash.buffer as ArrayBuffer;
      },
    );
    return module;
  })();
  return codec;
}

function readFields(
  fields: Map<string, unknown>,
  isProtected: (value: unknown) => value is { getText(): string },
): Map<string, FieldValue> {
  const out = new Map<string, FieldValue>();
  for (const [name, value] of fields) {
    if (isProtected(value)) {
      out.set(name, { text: value.getText(), protected: true });
    } else if (typeof value === "string") {
      out.set(name, { text: value, protected: false });
    }
    // A binary reference is not a string field and has no place in a draft.
  }
  return out;
}

/**
 * KeeOtp and its descendants store TOTP as a query string rather than a URI
 * (`key=JBSW…&step=30`). Everything else already hands over something
 * `normaliseTotp` understands.
 */
function totpFromOtpField(raw: string): string {
  const direct = normaliseTotp(raw);
  if (direct !== "") return direct;
  if (!raw.includes("=")) return "";
  const params = new URLSearchParams(raw);
  return normaliseTotp(params.get("key") ?? params.get("secret") ?? "");
}

/**
 * KeePassXC's own TOTP attributes, which carry the parameters separately
 * rather than as a URI.
 *
 * The URI built here is byte-identical to the one `crates/kdbx-bridge`
 * builds from the same attributes — same parameter set, same order, same
 * normalisation of KeePassXC's `HMAC-SHA-256` spelling — because both sides
 * have to agree on the value, not merely on its meaning.
 */
function totpFromTimeOtp(
  fields: Map<string, FieldValue>,
  title: string,
): string {
  const seed = normaliseTotp(fields.get("TimeOtp-Secret-Base32")?.text ?? "");
  if (seed === "") return "";
  const digits = wholeNumber(fields.get("TimeOtp-Length")?.text, 6);
  const period = wholeNumber(fields.get("TimeOtp-Period")?.text, 30);
  const algorithm =
    (fields.get("TimeOtp-Algorithm")?.text ?? "")
      .trim()
      .toUpperCase()
      .replaceAll("HMAC-", "")
      .replaceAll("-", "") || "SHA1";
  const label = title.trim() === "" ? "entry" : encodeURIComponent(title.trim());
  return `otpauth://totp/${label}?secret=${encodeURIComponent(seed)}&digits=${digits}&period=${period}&algorithm=${encodeURIComponent(algorithm)}`;
}

function wholeNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isoOf(value: unknown): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;
}

type MappedEntry = { item: DraftItem | null; skipped: SkippedRecord | null };

function mapPasskey(
  name: string,
  fields: Map<string, FieldValue>,
): MappedEntry {
  const rpId = fields.get(`${PASSKEY_PREFIX}RELYING_PARTY`)?.text ?? "";
  const credentialId = fields.get(`${PASSKEY_PREFIX}CREDENTIAL_ID`)?.text ?? "";
  if (rpId === "" || credentialId === "") {
    return {
      item: null,
      skipped: {
        name,
        reason:
          "A passkey entry without a relying party and a credential id has nothing this vault could recognise the credential by.",
      },
    };
  }
  const item = draftPasskey(name);
  item.rpId = rpId;
  item.username =
    fields.get(`${PASSKEY_PREFIX}USERNAME`)?.text ??
    fields.get("UserName")?.text ??
    "";
  // KeePassXC writes the credential id base64url, as WebAuthn does; the
  // vault's `…B64` fields are standard base64.
  item.credentialIdB64 = base64UrlToBase64(credentialId);
  // KeePassXC holds the private key, never a public one, and this vault holds
  // neither. The credential is a reference until it is registered again.
  item.publicKeyB64 = "";
  item.authenticator = "platform";
  return { item, skipped: null };
}

function mapEntry(name: string, fields: Map<string, FieldValue>): MappedEntry {
  const isPasskey = [...fields.keys()].some((key) =>
    key.startsWith(PASSKEY_PREFIX),
  );
  const mapped: MappedEntry = isPasskey
    ? mapPasskey(name, fields)
    : { item: draftLogin(name), skipped: null };
  const item = mapped.item;
  if (item === null) return mapped;

  item.notes = fields.get("Notes")?.text ?? "";

  if (item.kind === "login") {
    const login: DraftLogin = item;
    login.username = fields.get("UserName")?.text ?? "";
    login.password = fields.get("Password")?.text ?? "";
    addUri(login, fields.get("URL")?.text ?? "");
    const otp = fields.get("otp")?.text ?? "";
    login.totp =
      otp === "" ? totpFromTimeOtp(fields, name) : totpFromOtpField(otp);
  }

  // Sorted by KDBX field name rather than left in document order: KeePass
  // writers do not agree on an order, and the Rust mapping sorts too, so this
  // is what makes the two produce the same item from the same database.
  const extra = [...fields.keys()]
    .filter(
      (key) =>
        !NAMED_FIELDS.has(key) &&
        key !== "otp" &&
        !key.startsWith(TIME_OTP_PREFIX) &&
        !key.startsWith(PASSKEY_PREFIX),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of extra) {
    const value = fields.get(key);
    if (value !== undefined) addField(item, key, value.text, value.protected);
  }

  return { item, skipped: null };
}

/**
 * Two entries can share a title inside one group, and two groups can sanitise
 * to the same folder. The suffix keeps the mapping total and — because it is
 * applied in traversal order — identical between runs and between
 * implementations.
 */
function uniqueName(taken: Set<string>, folder: string, name: string): string {
  const key = (candidate: string) => `${folder}\u0000${candidate}`;
  if (!taken.has(key(name))) {
    taken.add(key(name));
    return name;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (${n})`;
    if (!taken.has(key(candidate))) {
      taken.add(key(candidate));
      return candidate;
    }
  }
}

/** The shape this adapter reads off kdbxweb, kept structural on purpose. */
type KdbxGroupLike = {
  name?: string;
  uuid?: { id?: string };
  entries: KdbxEntryLike[];
  groups: KdbxGroupLike[];
};

type KdbxEntryLike = {
  fields: Map<string, unknown>;
  binaries: Map<string, unknown>;
  tags?: string[];
  times?: { creationTime?: unknown; lastModTime?: unknown };
};

export const keepassKdbx: BinaryImportAdapter = {
  id: "keepass-kdbx",
  label: "KeePass / KeePassXC database (.kdbx)",
  shortName: "KeePass",
  hint: "The .kdbx database itself. You will be asked for its master password; key files are not supported yet.",
  accepts: "binary",

  detect: ({ bytes }) => hasKdbxMagic(bytes),

  parse: async (input): Promise<ParseResult> => {
    const bytes = input.bytes;
    if (bytes === null || !hasKdbxMagic(bytes)) {
      throw new KdbxImportError("That file is not a KeePass database.");
    }
    const password = input.password ?? "";
    if (password === "") {
      return passwordRequired(
        "keepass-kdbx",
        "This database is encrypted. It is opened in this tab, and the password is never stored or sent anywhere.",
      );
    }

    const kdbxweb = await loadCodec();
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const credentials = new kdbxweb.Credentials(
      kdbxweb.ProtectedValue.fromString(password),
    );

    let db: Awaited<ReturnType<typeof kdbxweb.Kdbx.load>>;
    try {
      db = await kdbxweb.Kdbx.load(buffer, credentials);
    } catch (caught) {
      if (caught instanceof KdbxImportError) throw caught;
      const code =
        caught !== null && typeof caught === "object" && "code" in caught
          ? String((caught as { code?: unknown }).code)
          : "";
      if (code === kdbxweb.Consts.ErrorCodes.InvalidKey) {
        throw new KdbxImportError(
          "That password did not open the database. If it also uses a key file, that is not supported yet.",
        );
      }
      throw new KdbxImportError(
        "That database could not be read. It may be truncated, or saved by a version this importer does not understand.",
      );
    }

    const isProtected = (value: unknown): value is { getText(): string } =>
      value instanceof kdbxweb.ProtectedValue;

    const items: DraftItem[] = [];
    const skipped: SkippedRecord[] = [];
    const warnings: string[] = [];
    const taken = new Set<string>();
    const recycleBin = db.meta.recycleBinUuid?.id ?? null;
    let attachments = 0;
    let passkeys = 0;

    const walk = (node: KdbxGroupLike, path: string[]): void => {
      if (recycleBin !== null && node.uuid?.id === recycleBin) {
        for (const entry of node.entries) {
          const title = entry.fields.get("Title");
          skipped.push({
            name: typeof title === "string" ? title : "Untitled",
            reason: "In the database's recycle bin.",
          });
        }
        return;
      }
      const folder = path.join("/");

      for (const entry of node.entries) {
        const fields = readFields(entry.fields, isProtected);
        const title = sanitiseSegment(fields.get("Title")?.text ?? "");
        const name = uniqueName(taken, folder, title);
        const { item, skipped: rejected } = mapEntry(name, fields);
        if (item === null) {
          if (rejected !== null) skipped.push(rejected);
          continue;
        }
        if (item.kind === "passkey") passkeys += 1;
        item.folder = folder === "" ? null : folder;
        item.createdAt = isoOf(entry.times?.creationTime);
        item.updatedAt = isoOf(entry.times?.lastModTime);
        if (entry.tags !== undefined && entry.tags.length > 0) {
          addField(item, "Tags", entry.tags.join(", "));
        }
        attachments += entry.binaries.size;
        items.push(item);
      }

      for (const child of node.groups) {
        walk(child, [...path, sanitiseSegment(child.name ?? "")]);
      }
    };

    // The top-level group is the database itself, so it contributes no folder.
    for (const root of db.groups) {
      walk(root as unknown as KdbxGroupLike, []);
    }

    if (attachments > 0) {
      warnings.push(
        `${attachments} ${attachments === 1 ? "attachment was" : "attachments were"} left behind. This vault stores fields, not files.`,
      );
    }
    if (passkeys > 0) {
      warnings.push(
        `${passkeys} ${passkeys === 1 ? "passkey is" : "passkeys are"} imported as a reference only. KeePassXC keeps the private key in the entry; this vault never holds one, so the credential has to be registered again before it can be used.`,
      );
    }

    return { source: "keepass-kdbx", items, skipped, warnings };
  },
};
