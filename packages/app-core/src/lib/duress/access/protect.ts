/**
 * AUTH-D: gate grant / recovery / policy / enrollment / export / secret-release
 * (including direct programmatic calls) through AccessContext + fence epochs.
 */

import { includesStringLiteral } from "../json-boundary.js";
import {
  type AccessContext,
  type EpochExpectation,
  assertContextAllows,
  isAccessContext,
} from "./context.js";

/** Operations that must never run on a forged or stale handle. */
export const PROTECTED_OPERATIONS = [
  "manage_grants",
  "mint_grant",
  "manage_policies",
  "manage_recovery",
  "enroll_trigger",
  "export_root",
  "export_policy",
  "export_backup",
  "release_secret",
  "unwrap_compartment",
] as const;

export type ProtectedOperation = (typeof PROTECTED_OPERATIONS)[number];

export function isProtectedOperation(op: string): op is ProtectedOperation {
  return includesStringLiteral(PROTECTED_OPERATIONS, op);
}

export type ProtectCheckInput = Readonly<{
  ctx: AccessContext | null;
  operation: ProtectedOperation | string;
  expected: EpochExpectation;
  retiredDevice?: boolean;
}>;

/**
 * Fail closed for protected paths. Direct programmatic callers must pass the
 * live AccessContext — JSON / public metadata is refused.
 */
export function assertProtectedOperation(input: ProtectCheckInput): void {
  if (input.retiredDevice) {
    throw new Error("retired_device");
  }
  if (!isProtectedOperation(input.operation) && !input.operation) {
    throw new Error("unsupported_operation");
  }
  if (!isAccessContext(input.ctx)) {
    throw new Error("stale_session: forged or deserialized access context");
  }
  assertContextAllows(input.ctx, input.operation, input.expected);
}

/**
 * Run a protected thunk only after the live context admits the operation.
 * Generation is rechecked after the thunk to catch revoke-during-use (AUTH-F).
 */
export async function withProtectedOperation<T>(
  input: ProtectCheckInput & {
    currentGeneration: () => number;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  assertProtectedOperation(input);
  const genAtStart = input.expected.sessionGeneration;
  const result = await run();
  if (input.currentGeneration() !== genAtStart) {
    throw new Error("stale_session: generation changed during protected op");
  }
  return result;
}
