import { deserialize } from "node:v8";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

/** Legacy internal payloads contain bounded server-owned V8 values, never browser input. */
export function scopeLegacyInternalPayload(
  model: string,
  id: string,
  payload: JsonObject,
): JsonObject {
  if (!model.startsWith("OpenSesame:")) return payload;
  if (!isString(payload.value) || payload.value.length > 2_800_000)
    throw new Error("Invalid legacy internal security record");
  const value: BoundaryValue = deserialize(
    Buffer.from(payload.value, "base64"),
  );
  const accountId = internalSecurityPrincipal(model, id, value);
  return accountId ? { ...payload, accountId } : payload;
}

export function internalSecurityPrincipal(
  model: string,
  key: string,
  value: BoundaryValue,
): string | undefined {
  if (isJsonObject(value)) {
    for (const field of ["principalId", "ownerPrincipalId"]) {
      if (isString(value[field])) return value[field];
    }
    if (isJsonObject(value.request)) {
      for (const field of ["principalId", "ownerPrincipalId"]) {
        if (isString(value.request[field])) return value.request[field];
      }
    }
  }
  return model === "OpenSesame:TotpSecret" || model === "OpenSesame:TotpStep"
    ? key
    : undefined;
}
