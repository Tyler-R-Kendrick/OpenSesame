/**
 * Deterministic digests for constraint comparison — no crypto dependency.
 * Equality is the contract; the prefix marks the canonicalization version.
 */

import type { Digest, PolicyConstraint } from "./types.js";

function escapeJsonString(value: string): string {
  return JSON.stringify(value);
}

function encodeAsset(
  constraint: Extract<PolicyConstraint, { kind: "asset" }>,
): string {
  const asset = constraint.asset;
  if (asset.kind === "fiat") {
    return `fiat:${escapeJsonString(asset.currency)}:${asset.exponent}`;
  }
  return `token:${escapeJsonString(asset.chainId)}:${escapeJsonString(asset.contract)}:${asset.decimals}:${escapeJsonString(asset.deploymentFingerprint)}`;
}

function encodeWindow(
  constraint: Extract<PolicyConstraint, { kind: "period" }>,
): string {
  const window = constraint.window;
  if (window.kind === "lifetime") {
    return `lifetime:${escapeJsonString(window.validFrom)}:${escapeJsonString(window.validUntil)}`;
  }
  if (window.kind === "fixed_interval") {
    return `fixed_interval:${escapeJsonString(window.anchor)}:${escapeJsonString(window.durationSeconds)}:${escapeJsonString(window.validUntil)}:none`;
  }
  return `calendar:${window.unit}:${escapeJsonString(window.timeZone)}:${escapeJsonString(window.boundaryScheduleRef)}:${escapeJsonString(window.validUntil)}:none`;
}

/** Stable, order-sensitive encoding of one typed constraint. */
export function constraintDigest(constraint: PolicyConstraint): Digest {
  const base = `${constraint.kind}|${constraint.ref}|critical=${constraint.critical ? "1" : "0"}|`;
  switch (constraint.kind) {
    case "amount":
      return `wp1:${base}ceiling=${constraint.ceiling}`;
    case "recipient": {
      const allowed = [...constraint.allowed].sort();
      return `wp1:${base}allowed=${allowed.map(escapeJsonString).join(",")}`;
    }
    case "period":
      return `wp1:${base}window=${encodeWindow(constraint)}`;
    case "fee":
      return `wp1:${base}maxFee=${constraint.maxFee}`;
    case "redelegation":
      return `wp1:${base}maxDepth=${constraint.maxDepth}`;
    case "asset":
      return `wp1:${base}asset=${encodeAsset(constraint)}`;
  }
}
