/**
 * Deployment-provided ambient policy from same-origin os-runtime-config.json.
 * URL query and localStorage cannot write this object.
 */

import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import type { BoundaryValue } from "@opensesame/os-domain";
import { type OperatorIdp, normalizeOperatorIdp } from "../settings.js";

let deployed: unknown;
let deployedProviders: OperatorIdp[] = [];

function readDeployedProviders(value: unknown): OperatorIdp[] {
  const raw: BoundaryValue = overlapCast(value);
  if (!isJsonObject(raw) || !Array.isArray(raw.providers)) return [];
  const out: OperatorIdp[] = [];
  for (const entry of raw.providers) {
    if (
      !isJsonObject(entry) ||
      !isString(entry.issuer) ||
      !isString(entry.clientId)
    ) {
      continue;
    }
    const idp = normalizeOperatorIdp(
      isString(entry.providerId) ? entry.providerId : "",
      entry.issuer,
      entry.clientId,
      isString(entry.label) ? entry.label : undefined,
    );
    if (idp) out.push(idp);
  }
  return out;
}

export function applyDeployedAmbientPolicy(value: unknown): void {
  deployed = value && typeof value === "object" ? value : undefined;
  deployedProviders = readDeployedProviders(value);
}

export function deployedAmbientPolicy(): unknown {
  return deployed;
}

export function deployedAmbientProviders(): readonly OperatorIdp[] {
  return deployedProviders;
}

export function resetDeployedAmbientPolicy(): void {
  deployed = undefined;
  deployedProviders = [];
}
