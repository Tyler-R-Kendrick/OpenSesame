/**
 * An account's login methods as a sealed-store trailer carries them
 * (ADR 0172, ADR 0037 §6). A manifest is a file somebody handed the Import
 * sheet, so every method read back is rebuilt from the fields its type names,
 * each checked against its shape: nothing else a file says reaches an item,
 * and a method that is not whole is left out rather than half trusted.
 *
 * The secrets a method holds — a password, a pepper seal, a Sphinx key, an
 * API key, a token, a client secret, a refresh token, an authenticator seed —
 * ride here as sealed content, exactly as a login's password and seed did.
 * They are written out, read back and passed on untouched.
 */
import {
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type CharacterRules,
  LOGIN_METHOD_TYPES,
  type LoginMethod,
  type PasswordGenerator,
  type PepperSeal,
} from "@opensesame/vault-core";

type Read<T> = (value: JsonObject) => T | null;

const text = (value: JsonValue | undefined): string | null =>
  value !== undefined && isString(value) ? value : null;
const flag = (value: JsonValue | undefined): boolean | null =>
  value !== undefined && isBoolean(value) ? value : null;
const count = (value: JsonValue | undefined): number | null =>
  value !== undefined && isNumber(value) && Number.isFinite(value)
    ? value
    : null;

function objectAt(value: JsonValue | undefined): JsonObject | null {
  return value !== undefined && isJsonObject(value) ? value : null;
}

function classFlags(
  value: JsonObject,
): Pick<
  CharacterRules,
  "lower" | "upper" | "digits" | "symbols" | "avoidAmbiguous"
> | null {
  const lower = flag(value.lower);
  const upper = flag(value.upper);
  const digits = flag(value.digits);
  const symbols = flag(value.symbols);
  const avoidAmbiguous = flag(value.avoidAmbiguous);
  return lower === null ||
    upper === null ||
    digits === null ||
    symbols === null ||
    avoidAmbiguous === null
    ? null
    : { lower, upper, digits, symbols, avoidAmbiguous };
}

function rulesOf(value: JsonObject): CharacterRules | null {
  const length = count(value.length);
  const minDigits = count(value.minDigits);
  const minSymbols = count(value.minSymbols);
  const flags = classFlags(value);
  return length === null ||
    minDigits === null ||
    minSymbols === null ||
    flags === null
    ? null
    : { length, minDigits, minSymbols, ...flags };
}

/** A generator that is not whole is `manual`, which keeps the typed secret. */
function generatorOf(value: JsonObject | null): PasswordGenerator | null {
  const manual: PasswordGenerator = { id: "manual" };
  if (value === null) return manual;
  if (value.id === "rules") {
    const rules = rulesOf(value);
    return rules === null ? manual : { id: "rules", ...rules };
  }
  if (value.id === "passphrase") {
    const words = count(value.words);
    const separator = text(value.separator);
    const capitalize = flag(value.capitalize);
    const includeNumber = flag(value.includeNumber);
    return words === null ||
      separator === null ||
      capitalize === null ||
      includeNumber === null
      ? manual
      : { id: "passphrase", words, separator, capitalize, includeNumber };
  }
  if (value.id === "sphinx") {
    // Without its key a Sphinx password is nothing: the method is not kept.
    const rules = rulesOf(objectAt(value.rules) ?? {});
    const realm = text(value.realm);
    const counter = count(value.counter);
    const oprfKeyB64 = text(value.oprfKeyB64);
    return rules === null ||
      realm === null ||
      counter === null ||
      oprfKeyB64 === null
      ? null
      : { id: "sphinx", rules, realm, counter, oprfKeyB64 };
  }
  return manual;
}

function kdfOf(value: JsonObject | null): PepperSeal["kdf"] | null {
  const saltB64 = text(value?.saltB64);
  const iterations = count(value?.iterations);
  return value?.alg !== "PBKDF2-SHA256" ||
    saltB64 === null ||
    iterations === null
    ? null
    : { alg: "PBKDF2-SHA256", saltB64, iterations };
}

/** `undefined` for no seal, `null` for one that is not whole. */
function sealOf(value: JsonValue | undefined): PepperSeal | null | undefined {
  if (value === undefined) return undefined;
  const seal = objectAt(value);
  const blob = objectAt(seal?.seal);
  const kdf = kdfOf(objectAt(seal?.kdf));
  const ivB64 = text(blob?.ivB64);
  const ctB64 = text(blob?.ctB64);
  return (seal?.v !== 1 && seal?.v !== 2) ||
    kdf === null ||
    ivB64 === null ||
    ctB64 === null
    ? null
    : { v: seal.v, kdf, seal: { ivB64, ctB64 } };
}

const password: Read<LoginMethod> = (m) => {
  const id = text(m.id);
  const secret = text(m.secret);
  const pepper = flag(m.pepper);
  const changedAt = text(m.changedAt);
  const generator = generatorOf(objectAt(m.generator));
  const sealed = sealOf(m.sealed);
  if (
    id === null ||
    secret === null ||
    pepper === null ||
    changedAt === null ||
    generator === null ||
    sealed === null
  ) {
    return null;
  }
  return {
    id,
    type: "password",
    generator,
    pepper,
    secret,
    ...(sealed === undefined ? undefined : { sealed }),
    changedAt,
  };
};

const apiKey: Read<LoginMethod> = (m) => {
  const id = text(m.id);
  const key = text(m.key);
  const header = text(m.header);
  return id === null || key === null || header === null
    ? null
    : { id, type: "api-key", key, header };
};

const token: Read<LoginMethod> = (m) => {
  const id = text(m.id);
  const value = text(m.token);
  const expiresAt = text(m.expiresAt);
  return id === null || value === null || expiresAt === null
    ? null
    : { id, type: "token", token: value, expiresAt };
};

const oauth: Read<LoginMethod> = (m) => {
  const id = text(m.id);
  const clientId = text(m.clientId);
  const clientSecret = text(m.clientSecret);
  const tokenUrl = text(m.tokenUrl);
  const scopes = text(m.scopes);
  const refreshToken = text(m.refreshToken);
  return id === null ||
    clientId === null ||
    clientSecret === null ||
    tokenUrl === null ||
    scopes === null ||
    refreshToken === null
    ? null
    : {
        id,
        type: "oauth",
        clientId,
        clientSecret,
        tokenUrl,
        scopes,
        refreshToken,
      };
};

const authenticator: Read<LoginMethod> = (m) => {
  const id = text(m.id);
  const secret = text(m.secret);
  return id === null || secret === null
    ? null
    : { id, type: "authenticator", secret };
};

const READERS = {
  password,
  "api-key": apiKey,
  token,
  oauth,
  authenticator,
} satisfies Record<(typeof LOGIN_METHOD_TYPES)[number], Read<LoginMethod>>;

/** One method rebuilt from the fields its type names, or null if it is not whole. */
export function readMethod(value: JsonValue): LoginMethod | null {
  if (!isJsonObject(value)) return null;
  const type = LOGIN_METHOD_TYPES.find((candidate) => candidate === value.type);
  return type === undefined ? null : READERS[type](value);
}

/**
 * The methods a trailer's `values.methods` holds: `null` when it holds no
 * list at all (the entry is not an account's), else every whole method in it.
 */
export function readMethods(
  value: JsonValue | undefined,
): LoginMethod[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const method = readMethod(entry);
    if (method === null || seen.has(method.id)) return [];
    seen.add(method.id);
    return [method];
  });
}

/** Methods as JSON for a trailer, in the one canonical key order. */
export function writeMethods(methods: readonly LoginMethod[]): JsonValue {
  const canonical = methods.flatMap((method) => {
    const whole = readMethod(overlapCast(method));
    return whole === null ? [] : [whole];
  });
  const json: JsonValue = overlapCast(canonical);
  return json;
}
