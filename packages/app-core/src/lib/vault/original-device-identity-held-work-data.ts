/** Identity algorithms DATA for one actual lexical holder; this factory grants no authentication or lock. */
import {
  type DeviceIdentityKeyRecord,
  clampDeviceKeyTime,
  deviceKeyField,
  isFutureDeviceKeyRecord,
  winningDeviceKey,
} from "@opensesame/vault-core";
import type { KeyCarryOutcome } from "../device-identity-carry.js";
import type { DeviceIdentityKey } from "../device-identity-key.js";
import { DeviceIdentityKeyError } from "../device-identity-record-data.js";
import type { captureOriginalDeviceIdentityCryptoData } from "../original-device-identity-crypto-data.js";
import type { OriginalIdentityBodyData } from "./original-device-identity-body-data.js";
import type { OriginalDeviceIdentityRecordIOData } from "./original-device-identity-record-io-contract.js";

function view(record: DeviceIdentityKeyRecord): DeviceIdentityKey {
  return {
    principalId: `prn_${record.keyId}`,
    keyId: record.keyId,
    publicJwk: { ...record.publicJwk },
    createdAt: record.createdAt,
  };
}

/** Every method must be invoked inside the original CRED→BODY→IDENTITY producer callback. */
export function bindOriginalDeviceIdentityHeldWorkData(
  body: OriginalIdentityBodyData,
  io: Pick<OriginalDeviceIdentityRecordIOData, "check" | "read" | "write">,
  cryptography: ReturnType<typeof captureOriginalDeviceIdentityCryptoData>,
) {
  const check = () => {
    body.check();
    io.check();
    cryptography.check();
  };
  const carried = async () => {
    check();
    const field = body.field();
    if (isFutureDeviceKeyRecord(field)) return { kind: "future" } as const;
    const record = await cryptography.trusted(field, body.bounds());
    check();
    return { kind: "current", record } as const;
  };
  const publishQuietly = async (record: DeviceIdentityKeyRecord) => {
    check();
    try {
      await body.publish(deviceKeyField(record));
    } catch {
      // A current auxiliary record remains usable when carrying it fails.
      // Retirement must propagate: it cannot turn failed old work into success.
      check();
    }
    check();
  };
  const ensure = async (): Promise<DeviceIdentityKey> => {
    check();
    const local = await io.read();
    check();
    if (local) return view(local);
    const found = await carried();
    check();
    if (found.kind === "future")
      throw new DeviceIdentityKeyError(
        "unreadable",
        "The vault carries an identity key of a newer version.",
      );
    if (found.record) {
      await io.write(found.record);
      check();
      return view(found.record);
    }
    // The actual producer must establish the required original identity fence;
    // neither this DATA factory nor a caller-provided boolean establishes it.
    const minted = await cryptography.mint();
    check();
    await io.write(minted);
    check();
    await publishQuietly(minted);
    check();
    return view(minted);
  };
  const reconcile = async (): Promise<KeyCarryOutcome> => {
    check();
    let local: DeviceIdentityKeyRecord | null;
    try {
      local = await io.read();
    } catch {
      check();
      return "kept";
    }
    check();
    const found = await carried();
    check();
    if (found.kind === "future") return "kept";
    const offered = found.record;
    if (!local) {
      if (!offered) return "none";
      await io.write(offered);
      check();
      return "adopted";
    }
    const mine = clampDeviceKeyTime(local, body.bounds());
    if (!offered) {
      await body.publish(deviceKeyField(mine));
      check();
      return "published";
    }
    if (mine.keyId === offered.keyId) return "same";
    if (winningDeviceKey(mine, offered) === offered) {
      await io.write(offered);
      check();
      return "replaced";
    }
    await body.publish(deviceKeyField(mine));
    check();
    return "published";
  };
  check();
  return Object.freeze({ check, ensure, reconcile });
}
