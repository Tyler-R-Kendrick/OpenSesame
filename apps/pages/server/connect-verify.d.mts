import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import type { VerifyTarget } from "./connect-verify-targets.generated.mjs";

export function verifyTargetFor(
  connector?: JsonObject | null,
): VerifyTarget | null;
export function recoverParams(
  target: VerifyTarget,
  connector?: JsonObject | null,
): Record<string, string>;
export function resolveTarget(
  target: VerifyTarget,
  connector?: JsonObject | null,
): VerifyTarget;
export function resolveTarget(
  target: VerifyTarget | null | undefined,
  connector?: JsonObject | null,
): VerifyTarget | null;
export function boundedJson(response: Response): Promise<{
  value: JsonValue;
  truncated: boolean;
}>;
export function verifyWithToken(
  target: VerifyTarget | null | undefined,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ status: number; ok: boolean; account: string } | null>;
