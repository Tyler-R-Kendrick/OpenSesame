import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import type { BitwardenNativeKey } from "./bitwarden-native-cose.js";
import {
  nativeCipherWire,
  nativeItemError,
  nativePersonalCipher,
  nativeText,
} from "./bitwarden-native-item.js";
import { SecretBackendError } from "./types.js";

type NativeCipherRequest = (
  path: string,
  init: RequestInit,
  maximum: number,
) => Promise<BoundaryValue>;
export type BitwardenNativeCipherApi = {
  get(id: string): Promise<JsonObject>;
  create(body: JsonObject): Promise<JsonObject>;
  update(id: string, body: JsonObject): Promise<JsonObject>;
  trash(id: string): Promise<void>;
};
function cipherPath(id: string): string {
  if (!z.string().uuid().safeParse(id).success)
    throw new SecretBackendError(
      "configuration",
      "Choose a valid Bitwarden item ID.",
    );
  return `ciphers/${encodeURIComponent(id)}`;
}
function reply(value: BoundaryValue, id?: string): JsonObject {
  const result = nativeCipherWire(value);
  if (!nativePersonalCipher(result) || (id !== undefined && result.id !== id))
    throw nativeItemError();
  return result;
}
function bodyText(
  body: JsonObject,
  userId: string,
  keyId: string,
  updating: boolean,
): string {
  if (body.organizationId !== null || (body.type !== 1 && body.type !== 2))
    throw nativeItemError();
  const result: JsonObject = { ...body, encryptedFor: userId };
  if (keyId) result.encryptedByKeyId = keyId;
  if (updating) {
    const revision = z.iso
      .datetime({ offset: true })
      .safeParse(body.revisionDate);
    if (!revision.success) throw nativeItemError();
    result.lastKnownRevisionDate = revision.data;
  } else {
    result.id = undefined;
  }
  const text = JSON.stringify(result);
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024)
    throw new SecretBackendError(
      "configuration",
      "The encrypted item exceeds the supported request size.",
    );
  return text;
}
/** Fixed personal-cipher endpoints only; renewal happens before requests, never as write replay. */
export function createBitwardenNativeCipherApi(
  request: NativeCipherRequest,
  check: () => void,
  userId: string,
  keyId: string,
): BitwardenNativeCipherApi {
  const write = async (path: string, body: JsonObject, updating: boolean) => {
    check();
    const text = bodyText(body, userId, keyId, updating);
    const result = await request(
      path,
      {
        method: updating ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: text,
      },
      8 * 1024 * 1024,
    );
    check();
    return reply(result, updating ? nativeText(body.id) : undefined);
  };
  return {
    get: async (id) => {
      check();
      const value = await request(cipherPath(id), {}, 8 * 1024 * 1024);
      check();
      return reply(value, id);
    },
    create: (body) => write("ciphers", body, false),
    update: (id, body) => {
      if (body.id !== id) throw nativeItemError();
      return write(cipherPath(id), body, true);
    },
    trash: async (id) => {
      check();
      await request(`${cipherPath(id)}/delete`, { method: "PUT" }, 0);
      check();
    },
  };
}

export function authorizeBitwardenCipherApi(
  request: NativeCipherRequest,
  renew: () => Promise<void>,
  token: () => string | undefined,
  check: () => void,
  userId: string,
  key: BitwardenNativeKey,
): BitwardenNativeCipherApi {
  return createBitwardenNativeCipherApi(
    async (path, init, maximum) => {
      check();
      await renew();
      check();
      const issued = token();
      if (!issued) throw nativeItemError();
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${issued}`);
      return request(path, { ...init, headers }, maximum);
    },
    check,
    userId,
    key.algorithm === -70010
      ? Array.from(key.id, (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        )
      : "",
  );
}
