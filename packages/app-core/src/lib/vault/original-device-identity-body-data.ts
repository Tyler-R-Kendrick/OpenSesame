/** Restricted body continuations for one private Store-owned callback; this DATA factory grants no authority. */
import type { JsonObject } from "@opensesame/os-domain";
import {
  DEVICE_KEY_CLOCK_MARGIN_MS,
  type VaultBody,
  type VaultHeader,
  clampDeviceKeyTime,
  deviceKeyField,
  deviceKeyTimeBounds,
  isFutureDeviceKeyRecord,
  mergeDeviceKeyFields,
} from "@opensesame/vault-core";

import type { captureOriginalDeviceIdentityCryptoData } from "../original-device-identity-crypto-data.js";

export type OriginalIdentityBodyStateData = Readonly<{
  tomb: string;
  header(): VaultHeader | null;
  body(): VaultBody;
}>;

/** `apply` must be the lexical private Store continuation, never a queued mutate or global carrier. */
export function bindOriginalIdentityBodyData(
  state: OriginalIdentityBodyStateData,
  apply: (change: (body: VaultBody) => void) => Promise<void>,
  original: () => void,
  cryptography: ReturnType<typeof captureOriginalDeviceIdentityCryptoData>,
) {
  original();
  const active = () => {
    original();
    cryptography.check();
  };
  const body = () => {
    active();
    return state.body();
  };
  const bounds = () => {
    active();
    return deviceKeyTimeBounds(state.header()?.createdAt);
  };
  const mutate = async (change: (body: VaultBody) => void) => {
    active();
    await apply((current) => {
      active();
      change(current);
      active();
    });
    active();
  };
  const publish = async (input: JsonObject) => {
    active();
    const offered = await cryptography.trusted(input, {
      now: Number.MAX_SAFE_INTEGER - DEVICE_KEY_CLOCK_MARGIN_MS,
    });
    active();
    if (!offered) return;
    const window = bounds();
    const record = clampDeviceKeyTime(offered, window);
    const held = body().deviceIdentityKey;
    if (isFutureDeviceKeyRecord(held)) return;
    const carried = await cryptography.trusted(held, window);
    active();
    if (carried?.keyId === record.keyId) return;
    const own = carried ? deviceKeyField(carried) : undefined;
    const next = mergeDeviceKeyFields(own, deviceKeyField(record));
    if (next === own) return;
    await mutate((current) => {
      current.deviceIdentityKey = next;
    });
  };
  return Object.freeze({
    tomb: state.tomb,
    check: active,
    body,
    field: () => body().deviceIdentityKey,
    bounds,
    mutate,
    publish,
  });
}

export type OriginalIdentityBodyData = ReturnType<
  typeof bindOriginalIdentityBodyData
>;
