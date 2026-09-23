/**
 * Deployment-provided ambient policy from same-origin os-runtime-config.json.
 * URL query and localStorage cannot write this object.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { type OperatorIdp, normalizeOperatorIdp } from "../settings.js";

let deployed: BoundaryValue | undefined;
let deployedProviders: OperatorIdp[] = [];

function readDeployedProviders(value: BoundaryValue): OperatorIdp[] {
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

export function applyDeployedAmbientPolicy(value: BoundaryValue): void {
  deployed = isJsonObject(value) ? value : undefined;
  deployedProviders = readDeployedProviders(value);
}

export function deployedAmbientPolicy(): BoundaryValue | undefined {
  return deployed;
}

export function deployedAmbientProviders(): readonly OperatorIdp[] {
  return deployedProviders;
}

export function resetDeployedAmbientPolicy(): void {
  deployed = undefined;
  deployedProviders = [];
}
