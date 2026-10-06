import { type JsonObject, isString } from "@opensesame/os-domain";
import { EventSealError, type EventSealer } from "./event-seal.js";

export interface OidcSealRow {
  model: string;
  id: string;
  payload: JsonObject;
  sealScope: string | null;
  uid: string | null;
  userCode: string | null;
  grantId: string | null;
}

export function oidcLookup(
  sealer: EventSealer,
  model: string,
  field: string,
  value: string,
): string {
  return sealer.lookupToken(
    JSON.stringify([
      "oidc_payloads",
      field === "grantId" ? null : model,
      field,
    ]),
    value,
  );
}

function payloadScope(payload: JsonObject): string {
  return JSON.stringify([
    "oidc",
    isString(payload.accountId) ? payload.accountId : null,
    isString(payload.clientId) ? payload.clientId : null,
  ]);
}

function purpose(model: string, id: string): string {
  return JSON.stringify(["oidc_payloads", model, id]);
}

export function sealOidcRow(
  sealer: EventSealer,
  model: string,
  id: string,
  payload: JsonObject,
): OidcSealRow {
  const digest = oidcLookup(sealer, model, "id", id);
  const scopedPayload =
    model.startsWith("OpenSesame:") && !isString(payload.accountId)
      ? { ...payload, accountId: digest }
      : payload;
  const sealScope = payloadScope(scopedPayload);
  const index = (field: string) =>
    isString(payload[field])
      ? oidcLookup(sealer, model, field, payload[field])
      : null;
  return {
    model,
    id: digest,
    payload: sealer.seal(purpose(model, digest), scopedPayload, sealScope),
    sealScope,
    uid: index("uid"),
    userCode: index("userCode"),
    grantId: index("grantId"),
  };
}

export function openOidcRow(sealer: EventSealer, row: OidcSealRow): JsonObject {
  if (
    row.sealScope === null ||
    !sealer.isSealed(row.payload) ||
    !isString(row.payload.$sealed) ||
    !row.payload.$sealed.startsWith("osev2.")
  )
    throw new EventSealError("oidc_payloads.payload");
  const payload = sealer.openCurrent(
    purpose(row.model, row.id),
    row.payload,
    row.sealScope,
  );
  if (payloadScope(payload) !== row.sealScope)
    throw new EventSealError("oidc_payloads.scope");
  for (const field of ["uid", "userCode", "grantId"] as const) {
    const index = isString(payload[field])
      ? oidcLookup(sealer, row.model, field, payload[field])
      : null;
    if (index !== row[field]) throw new EventSealError("oidc_payloads.index");
  }
  return payload;
}
