/** Compatible persistence boundary pins the supplied owner before loading its operation. */
import { assertNotDecoySession } from "../decoy-session.js";
import type { Records } from "./records.js";
export async function persistAuthenticatedRecords(
  input: { tomb: string; currentPassword: string },
  records: Records,
  generation: number,
): Promise<void> {
  assertNotDecoySession(generation);
  const operation = await import("./owner-operations.js");
  assertNotDecoySession(generation);
  return operation.persistAuthenticatedRecords(input, records, generation);
}
