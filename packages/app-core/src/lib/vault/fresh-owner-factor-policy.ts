/** Policy metadata only: no root proof, factor completion or admission permit. */
import {
  type BoundaryValue,
  type JsonObject,
  isBoolean,
  isJsonObject,
} from "@opensesame/os-domain";
import type {
  CodeChannel,
  RootProtectionManifest,
  VaultHeader,
} from "@opensesame/vault-core";

export type FreshOwnerPolicyHeader = Pick<
  VaultHeader,
  "protection" | "unlocks"
>;
export type FreshOwnerSecondStep = "totp" | CodeChannel;
export type FreshOwnerFactorPolicy = Readonly<{
  secondSteps: readonly FreshOwnerSecondStep[];
  recoveryCodesEnrolled: boolean;
}>;

const SUPPORTED_MANIFEST_VERSION =
  1 satisfies RootProtectionManifest["schemaVersion"];
const POLICY_UNAVAILABLE = "Fresh owner factor policy is unavailable.";
const GATE_FLAGS = [
  "totpEnrolled",
  "emailEnrolled",
  "smsEnrolled",
  "recoveryCodesEnrolled",
] as const;
const UNLOCK_FIELDS = new Set([
  "pin",
  "passkey",
  "passkeys",
  "totp",
  "email",
  "sms",
  "recovery",
]);

function refuse(): never {
  throw new Error(POLICY_UNAVAILABLE);
}

function hasGate(unlocks: JsonObject, field: string): boolean {
  const value = unlocks[field];
  if (value === undefined) return false;
  if (!isJsonObject(value)) refuse();
  return true;
}

function checkDeclaredGates(
  protection: BoundaryValue,
  actual: readonly boolean[],
): void {
  if (protection === undefined) return;
  if (
    !isJsonObject(protection) ||
    protection.schemaVersion !== SUPPORTED_MANIFEST_VERSION ||
    protection.purpose !== "human-vault-root" ||
    protection.criticalExtensions !== undefined
  )
    refuse();
  const gates = protection.legacyGates;
  if (!isJsonObject(gates)) refuse();
  if (
    Object.keys(gates).some((key) => !GATE_FLAGS.some((flag) => flag === key))
  )
    refuse();
  for (const [index, flag] of GATE_FLAGS.entries()) {
    if (
      !Object.hasOwn(gates, flag) ||
      !isBoolean(gates[flag]) ||
      gates[flag] !== actual[index]
    )
      refuse();
  }
}

/**
 * Inspect the original captured header before a parser can coerce gate flags.
 * The caller still authenticates the manifest MAC/body and each required factor.
 * Missing authenticated gate declarations are unsupported, not proof of no MFA.
 */
export function readFreshOwnerFactorPolicy(
  header: BoundaryValue,
): FreshOwnerFactorPolicy {
  if (!isJsonObject(header)) refuse();
  const unlocks = header.unlocks === undefined ? {} : header.unlocks;
  if (!isJsonObject(unlocks)) refuse();
  if (Object.keys(unlocks).some((key) => !UNLOCK_FIELDS.has(key))) refuse();

  const totp = hasGate(unlocks, "totp");
  const email = hasGate(unlocks, "email");
  const sms = hasGate(unlocks, "sms");
  const recovery = hasGate(unlocks, "recovery");
  const actual = [totp, email, sms, recovery];
  checkDeclaredGates(header.protection, actual);
  if (recovery && !totp && !email && !sms) refuse();

  const secondSteps: FreshOwnerSecondStep[] = [];
  if (totp) secondSteps.push("totp");
  if (email) secondSteps.push("email");
  if (sms) secondSteps.push("sms");
  return Object.freeze({
    secondSteps: Object.freeze(secondSteps),
    recoveryCodesEnrolled: recovery,
  });
}
