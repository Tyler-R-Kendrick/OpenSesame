/** Exact retained-global verifier matching DATA only; never a duress/REAL/session verdict. */
import { b64ToBytes } from "@opensesame/vault-core";
import type {
  PhysicalDeviceRecordReader,
  PhysicalRetiredCredentialRecord,
} from "../vault/physical-device-record-port.js";
import { passwordBytes, verifyRetiredPassword } from "./argon-verifier.js";
import { encodeRetiredCredentialContextV2 } from "./context-v2.js";
import { parseRetainedRetiredCredentialRecordsV2 } from "./records-v2.js";

const actualVerify = verifyRetiredPassword;
const actualCodec = parseRetainedRetiredCredentialRecordsV2;
const actualDecode = b64ToBytes;
const actualContext = encodeRetiredCredentialContextV2;
const actualPasswordBytes = passwordBytes;
export type DeviceRetiredCredentialMatch = Readonly<{
  tomb: string;
  trapId: string;
  context: string;
  expiresAt: string;
  response: "reject" | "synthetic_decoy";
}>;
type Inventory = Pick<
  PhysicalDeviceRecordReader,
  "check" | "revalidateRoot" | "captureRetiredCredentialInventory"
>;
function unavailable(): never {
  throw new Error(
    "Original global retired credential matching is unavailable.",
  );
}
function copyRows(rows: readonly PhysicalRetiredCredentialRecord[]) {
  if (!Array.isArray(rows) || rows.length > 32) unavailable();
  const selected = rows
    .map((row) => {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(row.tomb) ||
        !/^[0-9a-f]{64}$/u.test(row.ciphertextDigest) ||
        !row.physicalName ||
        row.physicalName.length > 512
      )
        unavailable();
      const parsed = actualCodec(row.wire);
      if (parsed.context.tomb !== row.tomb) unavailable();
      return Object.freeze({ ...row });
    })
    .sort((left, right) => left.tomb.localeCompare(right.tomb));
  if (new Set(selected.map((row) => row.tomb)).size !== selected.length)
    unavailable();
  return Object.freeze(selected);
}
/**
 * All retained contexts and expiration states are considered for dangerous duress
 * collision prevention. This does not permit a stale/foreign match to select a realm.
 * Caller retains the actual device-global credential lease and original producer;
 * caller-supplied reader, cancellation callback or returned list grants no authority.
 */
export async function matchDeviceRetiredCredentialData(
  inventory: Inventory,
  candidate: string,
  original: () => void,
): Promise<readonly DeviceRetiredCredentialMatch[]> {
  const encoded = actualPasswordBytes(candidate);
  encoded.fill(0);
  const capture = inventory.captureRetiredCredentialInventory;
  const checkReader = inventory.check;
  const revalidate = inventory.revalidateRoot;
  const check = () => {
    original();
    if (
      !capture ||
      inventory.captureRetiredCredentialInventory !== capture ||
      inventory.check !== checkReader ||
      inventory.revalidateRoot !== revalidate
    )
      unavailable();
    checkReader.call(inventory);
    original();
  };
  check();
  if (!capture) unavailable();
  await revalidate.call(inventory);
  check();
  const rows = copyRows(await capture.call(inventory));
  check();
  const matches: DeviceRetiredCredentialMatch[] = [];
  let count = 0;
  for (const row of rows) {
    const parsed = actualCodec(row.wire);
    count += parsed.traps.length;
    if (count > 96) unavailable();
    for (const trap of parsed.traps) {
      check();
      const salt = actualDecode(trap.salt);
      const verifier = actualDecode(trap.verifier);
      try {
        const matched = await actualVerify(candidate, salt, verifier);
        check();
        if (matched)
          matches.push(
            Object.freeze({
              tomb: row.tomb,
              trapId: trap.id,
              context: actualContext(parsed.context),
              expiresAt: trap.expiresAt,
              response: trap.response,
            }),
          );
      } finally {
        salt.fill(0);
        verifier.fill(0);
      }
    }
  }
  await revalidate.call(inventory);
  check();
  const next = copyRows(await capture.call(inventory));
  check();
  if (JSON.stringify(next) !== JSON.stringify(rows)) unavailable();
  return Object.freeze(matches);
}
