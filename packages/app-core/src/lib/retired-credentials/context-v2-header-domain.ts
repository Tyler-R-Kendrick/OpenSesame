/** Convert validated parsed metadata to exact optional domain fields; never an authentication proof. */
import type {
  RootProtectionManifest,
  TotpGateRecord,
  VaultHeader,
  VaultUnlocks,
} from "@opensesame/vault-core";
import { parseRootProtectionManifest } from "../vault/protection/parse.js";
import type { PagesRetiredParsedHeader } from "./context-v2-header.js";
type BoundDomainHeader = VaultHeader & { protection: RootProtectionManifest };
function domainUnlocks(
  unlocks: NonNullable<PagesRetiredParsedHeader["unlocks"]>,
): VaultUnlocks {
  const result: VaultUnlocks = {};
  if (unlocks.pin !== undefined) result.pin = unlocks.pin;
  if (unlocks.passkey !== undefined) result.passkey = unlocks.passkey;
  if (unlocks.passkeys !== undefined) result.passkeys = unlocks.passkeys;
  if (unlocks.email !== undefined) result.email = unlocks.email;
  if (unlocks.sms !== undefined) result.sms = unlocks.sms;
  if (unlocks.recovery !== undefined) result.recovery = unlocks.recovery;
  const totp = unlocks.totp;
  if (totp !== undefined) {
    const gate: TotpGateRecord = {
      secretWrap: totp.secretWrap,
      digits: totp.digits,
      period: totp.period,
    };
    if (totp.selfItemId !== undefined) gate.selfItemId = totp.selfItemId;
    result.totp = gate;
  }
  return result;
}
export function pagesRetiredHeaderDomain(
  header: PagesRetiredParsedHeader,
): BoundDomainHeader {
  const result: BoundDomainHeader = {
    v: header.v,
    createdAt: header.createdAt,
    protection: parseRootProtectionManifest(JSON.stringify(header.protection)),
  };
  if (header.kdf !== undefined) result.kdf = header.kdf;
  if (header.wrap !== undefined) result.wrap = header.wrap;
  if (header.hint !== undefined) result.hint = header.hint;
  if (header.bodyRev !== undefined) result.bodyRev = header.bodyRev;
  if (header.unlocks !== undefined)
    result.unlocks = domainUnlocks(header.unlocks);
  return result;
}
