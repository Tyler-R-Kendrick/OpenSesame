import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import type { HostRequestContext } from "./http.js";

export interface InvokeInput {
  connectionRef: string;
  operation: string;
  resource: string;
  invokeLevel?: number;
  input?: BoundaryValue;
}
export type ControlledReferenceAdmission =
  | { kind: "production"; assertCurrent(): void }
  | { kind: "canary"; response: "reject" | "synthetic_readonly" }
  | { kind: "reject" };
/** Installed runtime binding, never a client-request context or agent callback. */
export interface ControlledReferenceResolver {
  resolve(reference: string): Promise<ControlledReferenceAdmission>;
}
const RESERVED = "oscanary:";
const WIRE = /^oscanary:v1:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
function refused(): never {
  throw new Error("controlled_reference_rejected");
}
function syntheticResult(input: InvokeInput): BoundaryValue {
  const args = input.input ?? {};
  if (
    input.operation !== "canary.status" ||
    input.resource !== "synthetic" ||
    !isJsonObject(args) ||
    Object.keys(args).length !== 0
  )
    refused();
  return { synthetic: true, readonly: true, authority: "none" };
}
type InvocationAdmission =
  | { kind: "synthetic"; result: BoundaryValue }
  | { kind: "production"; check(): void };
async function prepareInvocation(
  input: InvokeInput,
  resolver?: ControlledReferenceResolver,
): Promise<InvocationAdmission> {
  const reserved = input.connectionRef.startsWith(RESERVED);
  if (reserved && !WIRE.test(input.connectionRef)) refused();
  const admission = await resolver?.resolve(input.connectionRef);
  if (admission?.kind === "canary") {
    if (admission.response !== "synthetic_readonly") refused();
    return { kind: "synthetic", result: syntheticResult(input) };
  }
  if (reserved || admission?.kind === "reject") refused();
  return {
    kind: "production",
    check:
      admission?.kind === "production"
        ? () => admission.assertCurrent()
        : () => {},
  };
}
/** Resolve reserved references before the authenticated production pipeline. */
export function operationInvoker(
  request: HostRequestContext["request"],
  resolver?: ControlledReferenceResolver,
) {
  return async function invoke(input: InvokeInput): Promise<BoundaryValue> {
    const admission = await prepareInvocation(input, resolver);
    if (admission.kind === "synthetic") return admission.result;
    admission.check();
    const res = await request("/api/v1/intents", {
      method: "POST",
      body: JSON.stringify({
        connection_ref: input.connectionRef,
        operation: input.operation,
        resource: input.resource,
        invoke_level: input.invokeLevel ?? 1,
        input: input.input ?? {},
      }),
    });
    admission.check();
    if (!res.ok) {
      const text = await res.text();
      admission.check();
      throw new Error(`invoke_failed:${res.status}:${text}`);
    }
    const value: BoundaryValue = await res.json();
    admission.check();
    return value;
  };
}
