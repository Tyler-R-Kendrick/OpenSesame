/** The Bitwarden vault's calls (ADR 0218): log in with the API key, open the vault key here, read items. */
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import { safeProviderText } from "./native-api-verify.js";
import {
  BitwardenCryptoError,
  type BitwardenKey,
  decryptBytes,
  decryptText,
  masterKey,
  stretchMasterKey,
  symmetricKey,
} from "./native-bitwarden-crypto.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { keyCall } from "./native-key-http.js";
import type { NativeKeyTarget } from "./native-key-types.js";

export const SITES = {
  us: {
    identity: "https://identity.bitwarden.com",
    api: "https://api.bitwarden.com",
  },
  eu: {
    identity: "https://identity.bitwarden.eu",
    api: "https://api.bitwarden.eu",
  },
} as const;

export const EMAIL = "email";
export const PASSWORD = "master_password";
export const CLIENT_ID = "client_id";
export const CLIENT_SECRET = "client_secret";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID_ONLY = new RegExp(`^${UUID}$`, "i");
export const API_CLIENT_ID = new RegExp(`^user\\.${UUID}$`, "i");
const MAX_NAMES = 200;
const MAX_VALUE = 32 * 1024;
/** The bridge's own answer limit: a vault larger than this cannot be listed from a page. */
const SYNC_LIMIT = 1024 * 1024;

export function servers(target: NativeKeyTarget) {
  const server = target.parameters.server;
  if (server) return { identity: `${server}/identity`, api: `${server}/api` };
  return target.parameters.site === "eu" ? SITES.eu : SITES.us;
}

/** Bitwarden's servers spell fields `Key` and Vaultwarden's `key`: read both as the first. */
function pascal(
  row: Record<string, BoundaryValue>,
): Record<string, BoundaryValue> {
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name.charAt(0).toUpperCase() + name.slice(1),
      isJsonObject(value) ? pascal(value) : value,
    ]),
  );
}

const text = z.string().max(1_000_000);
const LoginAnswer = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9._~+/=-]{20,8192}$/),
  Key: text,
  Kdf: z.union([z.literal(0), z.literal(1)]),
  KdfIterations: z.number().int(),
  KdfMemory: z.number().int().nullish(),
  KdfParallelism: z.number().int().nullish(),
});
const Cipher = z.object({
  Id: z.string().regex(UUID_ONLY),
  Type: z.number().int(),
  Name: text,
  Key: text.nullish(),
  Notes: text.nullish(),
  Login: z.object({ Password: text.nullish() }).passthrough().nullish(),
  OrganizationId: z.string().nullish(),
  DeletedDate: z.string().nullish(),
});
type CipherRow = z.infer<typeof Cipher>;

async function deviceIdentifier(clientId: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`opensesame:${clientId}`),
    ),
  );
  const hex = [...hash.slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Vault = { bearer: string; key: BitwardenKey; api: string };

function kdfOf(answer: z.infer<typeof LoginAnswer>) {
  if (answer.Kdf === 0)
    return { kind: "pbkdf2", iterations: answer.KdfIterations } as const;
  if (!answer.KdfMemory || !answer.KdfParallelism)
    throw new NativeApiError("response");
  return {
    kind: "argon2id",
    iterations: answer.KdfIterations,
    memoryMiB: answer.KdfMemory,
    parallelism: answer.KdfParallelism,
  } as const;
}

/** Log in with the personal API key, then open the vault key with the master password. Used for one call. */
export async function openVault(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
): Promise<Vault> {
  const where = servers(target);
  const row = await keyCall(
    transport,
    "POST",
    `${where.identity}/connect/token`,
    undefined,
    {
      kind: "form",
      value: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "api",
        client_id: target.credentials[CLIENT_ID] ?? "",
        client_secret: target.credentials[CLIENT_SECRET] ?? "",
        deviceType: "14",
        deviceIdentifier: await deviceIdentifier(
          target.credentials[CLIENT_ID] ?? "",
        ),
        deviceName: "OpenSesame",
      }),
    },
  );
  const answer = LoginAnswer.safeParse({
    ...pascal(row),
    access_token: row.access_token,
  });
  if (!answer.success) throw new NativeApiError("response");
  try {
    const master = await masterKey(
      target.credentials[PASSWORD] ?? "",
      target.credentials[EMAIL] ?? "",
      kdfOf(answer.data),
    );
    const userKey = symmetricKey(
      await decryptBytes(answer.data.Key, await stretchMasterKey(master)),
    );
    return { bearer: answer.data.access_token, key: userKey, api: where.api };
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    // The master password does not open this account's key: it is the one thing the account refuses.
    if (error instanceof BitwardenCryptoError)
      throw new NativeApiError("authorization");
    throw new NativeApiError("response");
  }
}

/** The key an item is sealed under: its own, if it carries one, else the vault key. */
async function itemKey(
  cipher: CipherRow,
  vault: BitwardenKey,
): Promise<BitwardenKey> {
  return cipher.Key
    ? symmetricKey(await decryptBytes(cipher.Key, vault))
    : vault;
}

const personal = (cipher: CipherRow) =>
  !cipher.OrganizationId && !cipher.DeletedDate;

function kindLabel(kind: number): string {
  switch (kind) {
    case 1:
      return "login";
    case 2:
      return "note";
    case 3:
      return "card";
    case 4:
      return "identity";
    default:
      return "item";
  }
}

export async function names(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
) {
  const vault = await openVault(target, transport);
  const body = await keyCall(
    transport,
    "GET",
    `${vault.api}/sync?excludeDomains=true`,
    vault.bearer,
    undefined,
    { limit: SYNC_LIMIT },
  );
  const list = pascal(body).Ciphers;
  if (!Array.isArray(list)) throw new NativeApiError("response");
  const items = [];
  for (const row of list) {
    if (items.length >= MAX_NAMES) break;
    if (!isJsonObject(row)) throw new NativeApiError("response");
    const parsed = Cipher.safeParse(pascal(row));
    if (!parsed.success) throw new NativeApiError("response");
    if (!personal(parsed.data)) continue;
    try {
      const name = await decryptText(
        parsed.data.Name,
        await itemKey(parsed.data, vault.key),
      );
      items.push({
        id: parsed.data.Id,
        label: safeProviderText(
          `${name.slice(0, 200)} · ${kindLabel(parsed.data.Type)}`,
          target.credentials,
        ),
      });
    } catch {
      throw new NativeApiError("response");
    }
  }
  return items;
}

/** The sealed value an item stands for: a login's password or a secure note's text. */
function sealedValue(cipher: CipherRow): string {
  const sealed =
    cipher.Type === 1
      ? cipher.Login?.Password
      : cipher.Type === 2
        ? cipher.Notes
        : null;
  if (!sealed)
    throw new Error("Only a login's password or a secure note can be read");
  return sealed;
}

export async function secretOf(
  target: NativeKeyTarget,
  transport: NativeProviderTransport,
  input: Record<string, string>,
) {
  const id = (input.item ?? "").trim();
  if (!UUID_ONLY.test(id)) throw new Error("Enter an item ID from the list");
  const vault = await openVault(target, transport);
  const body = await keyCall(
    transport,
    "GET",
    `${vault.api}/ciphers/${id}`,
    vault.bearer,
  );
  const parsed = Cipher.safeParse(pascal(body));
  if (!parsed.success || parsed.data.Id !== id || !personal(parsed.data))
    throw new NativeApiError("response");
  const sealed = sealedValue(parsed.data);
  try {
    const key = await itemKey(parsed.data, vault.key);
    const value = await decryptText(sealed, key);
    if (value.length > MAX_VALUE) throw new NativeApiError("response");
    return {
      id,
      label: safeProviderText(
        (await decryptText(parsed.data.Name, key)).slice(0, 200),
        target.credentials,
      ),
      value,
    };
  } catch (error) {
    if (error instanceof NativeApiError) throw error;
    throw new NativeApiError("response");
  }
}
