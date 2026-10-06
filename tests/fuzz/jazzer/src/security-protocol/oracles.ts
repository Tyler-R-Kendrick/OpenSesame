import type { ControlledValidatorBinding } from "@opensesame/app-core/lib/credential-canaries/validator-binding.js";
import type {
  ObservationAcknowledgement,
  ObservationMetadata,
  SealedObservationPackage,
} from "@opensesame/app-core/lib/credential-observation/protocol.js";
type ClosedProtocol =
  | ControlledValidatorBinding
  | ControlledValidatorBinding["context"]
  | ObservationMetadata
  | ObservationMetadata["event"]
  | SealedObservationPackage
  | ObservationAcknowledgement;
/** Expected input failures are distinct from oracle failures and unexpected bugs. */
export function invariant(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`security-fuzz oracle: ${message}`);
}
export function inputRejected(error: Error): boolean {
  if (error instanceof SyntaxError) return true;
  if (
    error instanceof TypeError &&
    "code" in error &&
    error.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
  )
    return true;
  if (error instanceof DOMException)
    return ["OperationError", "DataError", "InvalidCharacterError"].includes(
      error.name,
    );
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ZodError" ||
    [
      "Invalid controlled identifier.",
      "Controlled identifiers require 32 bytes.",
      "Canary request exceeds limit.",
      "Validator binding exceeds limit.",
      "A controlled MCP binding is required.",
      "Invalid observation receiver provision.",
      "Observation receiver provision is too large.",
      "Invalid observation key or wire encoding.",
      "Sealed observation is too large.",
      "Observation binding or expiry is invalid.",
      "Observation acknowledgement or package authentication failed.",
      "Invalid sealed observation.",
      "Observation timestamp is invalid.",
      "Observation acknowledgement is too large.",
      "Observation acknowledgement binding is invalid.",
    ].includes(error.message)
  );
}
export function parsed<T>(work: () => T): { value: T } | undefined {
  try {
    return { value: work() };
  } catch (error) {
    if (!(error instanceof Error) || !inputRejected(error)) throw error;
    return undefined;
  }
}
export async function parsedAsync<T>(
  work: () => Promise<T>,
): Promise<{ value: T } | undefined> {
  try {
    return { value: await work() };
  } catch (error) {
    if (!(error instanceof Error) || !inputRejected(error)) throw error;
    return undefined;
  }
}
export function closedKeys(
  value: ClosedProtocol,
  allowed: readonly string[],
): void {
  invariant(
    Object.keys(value).every((name) => allowed.includes(name)),
    "unexpected field admitted",
  );
}
export function closedMetadata(value: ObservationMetadata): void {
  closedKeys(value, ["v", "eventId", "vaultIdentity", "event", "at"]);
  const fields = {
    retired_credential_observed: ["type", "trapId", "response"],
    synthetic_decoy_interaction: ["type", "trapId", "response", "action"],
    controlled_canary_observed: [
      "type",
      "artifactId",
      "kind",
      "generation",
      "phase",
    ],
    receiver_test: ["type"],
  } satisfies Record<ObservationMetadata["event"]["type"], readonly string[]>;
  const eventFields = fields[value.event.type];
  invariant(
    eventFields !== undefined,
    "event grants an unrecognized capability",
  );
  closedKeys(value.event, eventFields);
  invariant(
    value.v === 1 && new Date(value.at).toISOString() === value.at,
    "noncanonical metadata",
  );
}
